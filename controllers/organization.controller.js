import { QueryTypes } from "sequelize";
import sequelize from "../config/database.js";
import Organization, { RetentionRateChange } from "../models/organization.model.js";
import User from "../models/users.js";

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
    res.status(200).json({
      success: true,
      data: organizations.map((org) => ({
        ...org.toJSON(),
        ...(req.user?.role === "admin" && { user_count: userCounts[org.name] || 0 }),
      })),
    });
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

// PUT /api/organizations/:id/retention-rate — sets the rate and logs the change.
// Existing revenue records keep the rate they were created with.
export const updateRetentionRate = async (req, res, next) => {
  try {
    const org = await Organization.findByPk(req.params.id);
    if (!org) return fail(next, 404, "Organisation not found");

    const { rate, error } = parseRate(req.body.rate);
    if (error) return fail(next, 400, error);
    if (rate === null) return fail(next, 400, "Retention rate is required");
    if (rate === org.retention_rate) {
      return fail(next, 400, `${org.name} is already at ${rate}%`);
    }
    const note = String(req.body.note ?? "").trim() || null;

    await sequelize.transaction(async (transaction) => {
      await RetentionRateChange.create(
        {
          organization_id: org.id,
          old_rate: org.retention_rate,
          new_rate: rate,
          note,
          changed_by: req.user.id,
        },
        { transaction },
      );
      await org.update({ retention_rate: rate }, { transaction });
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
      order: [["created_at", "DESC"]],
      limit: 200,
    });
    res.status(200).json({ success: true, data: changes });
  } catch (error) {
    next(error);
  }
};
