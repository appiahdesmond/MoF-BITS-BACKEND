import { QueryTypes } from "sequelize";
import sequelize from "../config/database.js";
import Organization, { RetentionRateChange } from "../models/organization.model.js";
import User from "../models/users.js";
import { changesByOrganization, rateOn, ratePeriods, today } from "../utils/retentionRate.js";

// Every table that stores an organisation by name. Renames are cascaded to all of
// them, and an organisation can only be deleted when none of them reference it.
const ORG_TABLES = [
  "users",
  "expenditures",
  "revenues",
  "cash",
  "activities",
  "reallocation",
  "loadeddata",
  "Notifications",
];

const RESERVED_NAMES = ["ALL"];

const fail = (next, statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return next(error);
};

const parseRate = (value) => {
  if (value === null || value === undefined || value === "") return { rate: null };
  const rate = Number(value);
  if (!Number.isInteger(rate) || rate < 0 || rate > 100) {
    return { error: "Retention rate must be a whole number from 0 to 100" };
  }
  return { rate };
};

const recordCount = async (name, transaction) => {
  let total = 0;
  for (const table of ORG_TABLES) {
    const [row] = await sequelize.query(
      `SELECT COUNT(*) AS n FROM \`${table}\` WHERE organization = ?`,
      { replacements: [name], type: QueryTypes.SELECT, transaction },
    );
    total += Number(row.n);
  }
  return total;
};

// GET /api/organizations — any logged-in user (dropdowns); admins also get user counts.
export const listOrganizations = async (req, res, next) => {
  try {
    const organizations = await Organization.findAll({ order: [["name", "ASC"]] });
    let userCounts = {};
    if (req.user?.role === "admin") {
      const rows = await sequelize.query(
        "SELECT organization, COUNT(*) AS n FROM users GROUP BY organization",
        { type: QueryTypes.SELECT },
      );
      userCounts = Object.fromEntries(rows.map((r) => [r.organization, Number(r.n)]));
    }
    // Rates come from the change history: the current rate is the one in force today,
    // and rate_periods lets forms pick the rate for a record's own date.
    const history = await changesByOrganization();
    const now = today();
    const data = [];
    for (const org of organizations) {
      const periods = ratePeriods(history[org.id] || [], org.retention_rate);
      const current = rateOn(periods, now);
      // Keep the stored rate in step once a scheduled change takes effect.
      if (current !== org.retention_rate) await org.update({ retention_rate: current });
      const next = periods.find((p) => p.from && p.from > now);
      data.push({
        ...org.toJSON(),
        retention_rate: current,
        rate_periods: periods,
        scheduled_rate: next ? { rate: next.rate, effective_date: next.from } : null,
        ...(req.user?.role === "admin" && { user_count: userCounts[org.name] || 0 }),
      });
    }
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// POST /api/organizations
export const createOrganization = async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim();
    const code = String(req.body.code ?? "").trim() || null;
    if (!name) return fail(next, 400, "Organisation name is required");
    if (RESERVED_NAMES.includes(name.toUpperCase())) {
      return fail(next, 400, `"${name}" is reserved and can't be used as a name`);
    }
    const { rate, error } = parseRate(req.body.retention_rate);
    if (error) return fail(next, 400, error);

    const existing = await Organization.findOne({ where: { name } });
    if (existing) return fail(next, 409, "An organisation with this name already exists");

    const organization = await sequelize.transaction(async (transaction) => {
      const org = await Organization.create(
        { name, code, status: "active", retention_rate: rate },
        { transaction },
      );
      if (rate !== null) {
        await RetentionRateChange.create(
          {
            organization_id: org.id,
            old_rate: null,
            new_rate: rate,
            note: "Initial rate",
            changed_by: req.user.id,
            effective_date: today(),
          },
          { transaction },
        );
      }
      return org;
    });

    res.status(201).json({ success: true, data: { ...organization.toJSON(), user_count: 0 } });
  } catch (error) {
    next(error);
  }
};

// PUT /api/organizations/:id — rename, change code, activate/deactivate.
export const updateOrganization = async (req, res, next) => {
  try {
    const org = await Organization.findByPk(req.params.id);
    if (!org) return fail(next, 404, "Organisation not found");

    const updates = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return fail(next, 400, "Organisation name is required");
      if (RESERVED_NAMES.includes(name.toUpperCase())) {
        return fail(next, 400, `"${name}" is reserved and can't be used as a name`);
      }
      if (name !== org.name) {
        const clash = await Organization.findOne({ where: { name } });
        if (clash) return fail(next, 409, "An organisation with this name already exists");
        updates.name = name;
      }
    }
    if (req.body.code !== undefined) {
      updates.code = String(req.body.code ?? "").trim() || null;
    }
    if (req.body.status !== undefined) {
      if (!["active", "inactive"].includes(req.body.status)) {
        return fail(next, 400, "Status must be active or inactive");
      }
      updates.status = req.body.status;
    }

    const oldName = org.name;
    let renamedRecords = 0;
    await sequelize.transaction(async (transaction) => {
      if (updates.name) {
        for (const table of ORG_TABLES) {
          const [, meta] = await sequelize.query(
            `UPDATE \`${table}\` SET organization = ? WHERE organization = ?`,
            { replacements: [updates.name, oldName], transaction },
          );
          renamedRecords += meta?.affectedRows ?? 0;
        }
      }
      await org.update(updates, { transaction });
    });

    res.status(200).json({ success: true, data: org, renamedRecords });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/organizations/:id — only when nothing references it.
export const deleteOrganization = async (req, res, next) => {
  try {
    const org = await Organization.findByPk(req.params.id);
    if (!org) return fail(next, 404, "Organisation not found");

    const inUse = await recordCount(org.name);
    if (inUse > 0) {
      return fail(
        next,
        409,
        `${org.name} is used by ${inUse} user(s) or record(s), so it can't be deleted. Mark it inactive instead.`,
      );
    }
    await org.destroy();
    res.status(200).json({ success: true, id: org.id });
  } catch (error) {
    next(error);
  }
};

// PUT /api/organizations/:id/retention-rate
//   { rate, effectiveDate, approvalReference, reason }
// Records a rate change that applies to revenue collected from the effective date.
// Revenue records already saved keep the rate they were saved with.
export const updateRetentionRate = async (req, res, next) => {
  try {
    const org = await Organization.findByPk(req.params.id);
    if (!org) return fail(next, 404, "Organisation not found");

    const { rate, error } = parseRate(req.body.rate);
    if (error) return fail(next, 400, error);
    if (rate === null) return fail(next, 400, "Retention rate is required");

    const effectiveDate = String(req.body.effectiveDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || Number.isNaN(Date.parse(effectiveDate))) {
      return fail(next, 400, "Effective date is required (YYYY-MM-DD)");
    }
    const approvalReference = String(req.body.approvalReference ?? "").trim();
    if (!approvalReference) return fail(next, 400, "Approval reference is required");
    if (approvalReference.length > 100) {
      return fail(next, 400, "Approval reference must be 100 characters or fewer");
    }
    const reason = String(req.body.reason ?? req.body.note ?? "").trim();
    if (!reason) return fail(next, 400, "Reason for change is required");
    if (reason.length > 255) return fail(next, 400, "Reason must be 255 characters or fewer");

    const before = ratePeriods((await changesByOrganization([org.id]))[org.id] || [], org.retention_rate);
    const rateThen = rateOn(before, effectiveDate);
    if (rate === rateThen) {
      return fail(next, 400, `${org.name} is already at ${rate}% on ${effectiveDate}`);
    }

    await sequelize.transaction(async (transaction) => {
      await RetentionRateChange.create(
        {
          organization_id: org.id,
          old_rate: rateThen,
          new_rate: rate,
          note: reason,
          approval_reference: approvalReference,
          effective_date: effectiveDate,
          changed_by: req.user.id,
        },
        { transaction },
      );
      const after = ratePeriods(
        (await RetentionRateChange.findAll({ where: { organization_id: org.id }, transaction })) || [],
        org.retention_rate,
      );
      await org.update({ retention_rate: rateOn(after, today()) }, { transaction });
    });

    res.status(200).json({ success: true, data: org });
  } catch (error) {
    next(error);
  }
};

// GET /api/organizations/retention-rate-changes?organizationId=
export const listRetentionRateChanges = async (req, res, next) => {
  try {
    const where = {};
    if (req.query.organizationId) where.organization_id = Number(req.query.organizationId);
    const changes = await RetentionRateChange.findAll({
      where,
      include: [
        { model: Organization, attributes: ["id", "name"] },
        { model: User, as: "changedBy", attributes: ["id", "name", "username"] },
      ],
      order: [
        ["effective_date", "DESC"],
        ["created_at", "DESC"],
      ],
      limit: 200,
    });
    // The rate each change replaced, worked out from effective dates, so a backdated
    // change shows correctly against the changes around it.
    const all = await changesByOrganization([...new Set(changes.map((c) => c.organization_id))]);
    const previous = {};
    Object.values(all).forEach((list) => {
      const sorted = [...list].sort(
        (x, y) => String(x.effective_date).localeCompare(String(y.effective_date)) || x.id - y.id,
      );
      sorted.forEach((c, i) => {
        previous[c.id] = i === 0 ? c.old_rate : sorted[i - 1].new_rate;
      });
    });
    const now = today();
    res.status(200).json({
      success: true,
      data: changes.map((c) => ({
        ...c.toJSON(),
        previous_rate: previous[c.id] ?? c.old_rate,
        scheduled: String(c.effective_date) > now,
      })),
    });
  } catch (error) {
    next(error);
  }
};
