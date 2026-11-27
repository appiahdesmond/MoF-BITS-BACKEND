// Budget Ceilings (PCMED). One consolidated distribution per financial year and version:
// PCMED (ceilings.prepare) captures the Ministry ceiling and distributes it across DADs by
// funding source and economic classification; the distribution goes through
//   Draft/Returned → PendingRecommendation (ceilings.recommend) → PendingEndorsement
//   (ceilings.endorse) → PendingApproval (ceilings.approve, Hon. Deputy Minister) → Approved.
// On final approval each DAD's ceiling is published, its Revised Work Plan activated and the
// DAD notified. All amounts are exact pesewas; every check runs here, not only in the browser.
import { Op } from "sequelize";
import sequelize from "../config/database.js";
import User from "../models/users.js";
import Notification from "../models/notification.model.js";
import Organization from "../models/organization.model.js";
import {
  CeilingAllocation,
  CeilingDistribution,
  CeilingDistributionVersion,
  CeilingDocument,
  DadCeiling,
  MinistryCeiling,
} from "../models/budgetCeiling.model.js";
import {
  NaturalAccount,
  WorkPlan,
  WorkPlanActivity,
  WorkPlanCostItem,
  WorkPlanOutput,
  WorkPlanQuarterActivity,
  WorkPlanVersion,
} from "../models/workPlan.model.js";
import { CEILING_KEYS, FUNDS, KEY_LABEL, ceilingKey, centsRow, toCents } from "../utils/ceilingKeys.js";
import { permissionsForRole } from "../utils/permissions.js";
import { logWorkflowEvent, workflowHistory } from "../utils/workflowLog.js";
import { notifyOrganization } from "../utils/notify.js";
import { ROLES } from "../utils/pageAccess.js";

const fail = (message, statusCode = 400, extra = {}) => Object.assign(new Error(message), { statusCode, ...extra });
const EDITABLE = new Set(["Draft", "Returned"]);
const MAX_CENTS = 1e15;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const fromCents = (c) => (c === null || c === undefined ? null : (c / 100).toFixed(2));
const ENTITY = "budgetCeiling";
export const STATUS_LABEL = {
  Draft: "Draft",
  PendingRecommendation: "Pending Recommendation",
  PendingEndorsement: "Pending Endorsement",
  PendingApproval: "Pending Approval",
  Returned: "Returned to PCMED",
  Approved: "Approved",
};
// Stages that reached PCMED: an Initial Work Plan at one of these feeds the requirements.
const AT_PCMED = ["SubmittedToPCMED", "UnderVerification", "Verified"];

async function can(user, permission) {
  return Boolean((await permissionsForRole(user.role))[permission]);
}
async function assertCan(user, permission) {
  if (!(await can(user, permission))) throw fail("Your role cannot take this step", 403);
}
const validYear = (year) => {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw fail("Choose a valid financial year");
  return y;
};
async function dads() {
  const rows = await Organization.findAll({ where: { status: "active" }, order: [["name", "ASC"]] });
  return rows.map((o) => ({ name: o.name, code: o.code }));
}

/* ---------- initial resource requirements (from Work Plan submissions) ---------- */

/** Requirement of a Work Plan tree by ceiling key (pesewas); costing outside the eight classifications is reported apart. */
function aggregateTree(outputs, accounts) {
  const amounts = Object.fromEntries(CEILING_KEYS.map((k) => [k, 0]));
  let unclassified = 0;
  let items = 0;
  for (const o of outputs)
    for (const a of o.activities ?? [])
      for (const q of a.quarters ?? [])
        for (const i of q.items ?? []) {
          items += 1;
          const key = ceilingKey(i.fundingSource, accounts.get(i.naturalAccountId)?.economic_classification);
          if (key) amounts[key] += i.amountCents ?? 0;
          else unclassified += i.amountCents ?? 0;
        }
  return { amounts, unclassified, items };
}

async function accountMap() {
  return new Map((await NaturalAccount.findAll()).map((a) => [a.id, a]));
}

/**
 * Current baseline per DAD: the latest submitted version of its Initial Work Plan once the
 * plan has reached PCMED. DADs without one are "not submitted" (never zero).
 */
export async function liveRequirements(year) {
  const [orgs, accounts] = await Promise.all([dads(), accountMap()]);
  const plans = await WorkPlan.findAll({ where: { year, stage: "Initial" } });
  const out = {};
  for (const { name } of orgs) {
    const plan = plans.find((p) => p.organization === name);
    if (!plan || !AT_PCMED.includes(plan.status)) {
      out[name] = { status: "notSubmitted", planStatus: plan?.status ?? null, planId: plan?.id ?? null };
      continue;
    }
    const version = await WorkPlanVersion.findOne({ where: { work_plan_id: plan.id }, order: [["id", "DESC"]] });
    if (!version) {
      out[name] = { status: "notSubmitted", planStatus: plan.status, planId: plan.id };
      continue;
    }
    const agg = aggregateTree(version.snapshot, accounts);
    out[name] = { status: "submitted", planId: plan.id, planStatus: plan.status, versionId: version.id, submittedAt: version.created_at, submittedBy: version.created_by, ...agg };
  }
  return out;
}

/* ---------- shapes ---------- */

const ceilingDto = (c, doc) =>
  c && {
    id: c.id,
    year: c.year,
    version: c.version,
    reference: c.reference ?? "",
    communicatedOn: c.communicated_on,
    remarks: c.remarks ?? "",
    amendmentReason: c.amendment_reason,
    amounts: centsRow(c),
    document: doc ? { id: doc.id, name: doc.file_name, size: doc.size, mime: doc.mime_type } : null,
    createdBy: c.created_by,
    createdAt: c.created_at,
  };
const distDto = (d) => ({
  id: d.id,
  year: d.year,
  version: d.version,
  status: d.status,
  revision: d.revision,
  ministryCeilingId: d.ministry_ceiling_id,
  submittedBy: d.submitted_by,
  submittedById: d.submitted_by_id,
  submittedAt: d.submitted_at,
  recommendedById: d.recommended_by_id,
  endorsedById: d.endorsed_by_id,
  approvedBy: d.approved_by,
  approvedAt: d.approved_at,
  returnedBy: d.returned_by,
  returnedAt: d.returned_at,
  returnReason: d.return_reason,
  returnedStage: d.returned_stage,
  updatedBy: d.updated_by,
  updatedAt: d.updated_at,
});

/** Complete validation of a distribution against its Ministry ceiling (exact, per classification). */
export function validateDistribution({ ceiling, allocations, organizations }) {
  const errors = [];
  if (!ceiling) {
    errors.push({ code: "noCeiling", message: "Capture the Ministry ceiling first" });
    return { errors };
  }
  if (!ceiling.reference?.trim()) errors.push({ code: "reference", message: "Enter the official communication reference of the Ministry ceiling" });
  if (!ceiling.communicatedOn) errors.push({ code: "date", message: "Enter the date the Ministry ceiling was communicated" });
  if (!ceiling.document) errors.push({ code: "document", message: "Attach the Ministry ceiling communication" });
  const names = new Set(organizations.map((o) => o.name));
  for (const a of allocations) if (!names.has(a.organization)) errors.push({ code: "dad", organization: a.organization, message: `${a.organization} is not an active DAD` });
  const missing = organizations.filter((o) => {
    const row = allocations.find((a) => a.organization === o.name);
    return !row || CEILING_KEYS.some((k) => row.amounts[k] === null);
  });
  if (missing.length)
    errors.push({
      code: "missing",
      organizations: missing.map((o) => o.name),
      message: `${missing.length} DAD${missing.length === 1 ? " has" : "s have"} classifications not entered (enter 0 where there is no ceiling): ${missing.map((o) => o.name).slice(0, 4).join(", ")}${missing.length > 4 ? "…" : ""}`,
    });
  for (const k of CEILING_KEYS) {
    const distributed = sum(allocations.map((a) => a.amounts[k] ?? 0));
    const diff = ceiling.amounts[k] - distributed;
    if (diff < 0) errors.push({ code: "over", key: k, message: `${KEY_LABEL[k]} is over-allocated by GH₵${(-diff / 100).toLocaleString("en-GH", { minimumFractionDigits: 2 })}` });
    else if (diff > 0) errors.push({ code: "unallocated", key: k, message: `${KEY_LABEL[k]} has GH₵${(diff / 100).toLocaleString("en-GH", { minimumFractionDigits: 2 })} not yet distributed` });
  }
  return { errors };
}

async function latestDistribution(year, transaction) {
  return CeilingDistribution.findOne({ where: { year }, order: [["version", "DESC"]], transaction });
}

async function describe(dist, transaction) {
  const organizations = await dads();
  const rows = await CeilingAllocation.findAll({ where: { distribution_id: dist.id }, transaction });
  const allocations = rows.map((r) => ({ organization: r.organization, amounts: centsRow(r), updatedBy: r.updated_by, updatedAt: r.updated_at }));
  const ceilingRow = dist.ministry_ceiling_id ? await MinistryCeiling.findByPk(dist.ministry_ceiling_id, { transaction }) : null;
  const doc = ceilingRow?.document_id ? await CeilingDocument.findByPk(ceilingRow.document_id, { attributes: ["id", "file_name", "size", "mime_type"], transaction }) : null;
  const ceiling = ceilingDto(ceilingRow, doc);
  const frozen = !EDITABLE.has(dist.status) && dist.requirements_snapshot;
  const requirements = frozen ? dist.requirements_snapshot : await liveRequirements(dist.year);
  const dadCeilings = dist.status === "Approved" ? await DadCeiling.findAll({ where: { distribution_id: dist.id }, order: [["organization", "ASC"]], transaction }) : [];
  return {
    distribution: distDto(dist),
    organizations,
    allocations,
    ceiling,
    requirements,
    requirementsFrozen: Boolean(frozen),
    validation: validateDistribution({ ceiling, allocations, organizations }),
    communication: dadCeilings.map(dadCeilingDto),
  };
}

const dadCeilingDto = (c) => ({
  id: c.id,
  organization: c.organization,
  year: c.year,
  amounts: centsRow(c),
  approvedBy: c.approved_by,
  approvedAt: c.approved_at,
  reference: c.communication_reference,
  publishedAt: c.published_at,
  notifiedAt: c.notified_at,
  acknowledgedAt: c.acknowledged_at,
  acknowledgedBy: c.acknowledged_by,
  workPlanId: c.work_plan_id,
  activationStatus: c.activation_status,
  activationError: c.activation_error,
});

/* ---------- reading ---------- */

export async function getWorkspace(user, { year }) {
  const y = validYear(year);
  let dist = await latestDistribution(y);
  if (!dist) {
    if (!(await can(user, "ceilings.prepare"))) return { distribution: null, organizations: await dads(), allocations: [], ceiling: null, requirements: await liveRequirements(y), validation: { errors: [] }, communication: [] };
    const ceiling = await MinistryCeiling.findOne({ where: { year: y }, order: [["version", "DESC"]] });
    dist = await CeilingDistribution.create({ year: y, version: 1, status: "Draft", ministry_ceiling_id: ceiling?.id ?? null, created_by: user.name, created_by_id: user.id, updated_by: user.name, updated_by_id: user.id });
    await logWorkflowEvent({ entityType: ENTITY, record: dist, action: "created", from: null, to: "Draft", user });
  }
  const versions = await CeilingDistribution.findAll({ where: { year: y }, attributes: ["id", "version", "status", "approved_at"], order: [["version", "ASC"]] });
  return { ...(await describe(dist)), versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, approvedAt: v.approved_at })) };
}

async function loadDistribution(id, transaction) {
  const d = await CeilingDistribution.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!d) throw fail("Ceiling distribution not found", 404);
  return d;
}
export async function getDistribution(user, id) {
  return describe(await loadDistribution(id));
}

/* ---------- Ministry ceiling ---------- */

const ALLOWED_DOCS = ["application/pdf", "image/png", "image/jpeg", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword"];

/** Save the Ministry ceiling as a new version (earlier versions are kept) and point the draft distribution at it. */
export async function saveMinistryCeiling(user, body, file) {
  await assertCan(user, "ceilings.prepare");
  const y = validYear(body.year);
  return sequelize.transaction(async (transaction) => {
    const dist = await latestDistribution(y, transaction);
    if (dist && !EDITABLE.has(dist.status)) throw fail(`The ${y} distribution is ${STATUS_LABEL[dist.status].toLowerCase()}; the Ministry ceiling cannot change now`, 409);
    if (dist && Number(body.revision) !== dist.revision) throw fail("The distribution changed since you opened it. Reload and try again.", 409, { code: "stale", revision: dist.revision });
    const previous = await MinistryCeiling.findOne({ where: { year: y }, order: [["version", "DESC"]], transaction });
    let amounts;
    try {
      amounts = typeof body.amounts === "string" ? JSON.parse(body.amounts) : body.amounts;
    } catch {
      throw fail("The ceiling amounts are not valid");
    }
    const values = {};
    for (const k of CEILING_KEYS) {
      const c = Number(amounts?.[k]);
      if (!Number.isInteger(c) || c < 0 || c >= MAX_CENTS) throw fail(`${KEY_LABEL[k]}: enter an amount of zero or more`);
      values[k] = fromCents(c);
    }
    const reason = String(body.amendmentReason ?? "").trim();
    if (previous && !reason) throw fail("Give the reason for revising the Ministry ceiling");
    let documentId = previous?.document_id ?? null;
    if (file) {
      if (!ALLOWED_DOCS.includes(file.mimetype)) throw fail("Attach a PDF, Word document or image");
      const doc = await CeilingDocument.create({ file_name: file.originalname.slice(0, 255), mime_type: file.mimetype, size: file.size, data: file.buffer, created_by: user.name, created_by_id: user.id }, { transaction });
      documentId = doc.id;
    }
    const row = await MinistryCeiling.create(
      {
        year: y,
        version: (previous?.version ?? 0) + 1,
        reference: String(body.reference ?? "").trim().slice(0, 120) || null,
        communicated_on: body.communicatedOn || null,
        remarks: String(body.remarks ?? "").trim() || null,
        amendment_reason: previous ? reason : null,
        document_id: documentId,
        ...values,
        created_by: user.name,
        created_by_id: user.id,
        updated_by: user.name,
        updated_by_id: user.id,
      },
      { transaction },
    );
    let d = dist;
    if (!d) d = await CeilingDistribution.create({ year: y, version: 1, status: "Draft", created_by: user.name, created_by_id: user.id }, { transaction });
    await d.update({ ministry_ceiling_id: row.id, revision: d.revision + 1, updated_by: user.name, updated_by_id: user.id }, { transaction });
    const changes = previous ? CEILING_KEYS.filter((k) => toCents(previous[k]) !== toCents(row[k])).map((k) => `${KEY_LABEL[k]}: ${previous[k]} → ${row[k]}`) : [];
    await logWorkflowEvent({ entityType: ENTITY, record: d, action: previous ? "ceilingRevised" : "ceilingCaptured", from: d.status, to: d.status, comment: [`Ministry ceiling v${row.version}${row.reference ? ` (${row.reference})` : ""}`, reason, ...changes].filter(Boolean).join(" · ").slice(0, 2000), user });
    return describe(d, transaction);
  });
}

export async function ministryCeilingVersions(user, year) {
  const rows = await MinistryCeiling.findAll({ where: { year: validYear(year) }, order: [["version", "DESC"]] });
  return rows.map((c) => ceilingDto(c, c.document_id ? { id: c.document_id, file_name: "", size: 0, mime_type: "" } : null));
}

export async function getDocument(id) {
  const doc = await CeilingDocument.findByPk(id);
  if (!doc) throw fail("Document not found", 404);
  return doc;
}

/* ---------- distribution entry ---------- */

/** Save changed cells: [{ organization, key, cents | null }]. Refused when the revision is stale. */
export async function saveAllocations(user, id, { revision, changes }) {
  await assertCan(user, "ceilings.prepare");
  if (!Array.isArray(changes) || !changes.length) throw fail("No changes given");
  if (changes.length > 2000) throw fail("Too many changes at once");
  const names = new Set((await dads()).map((o) => o.name));
  return sequelize.transaction(async (transaction) => {
    const dist = await loadDistribution(id, transaction);
    if (!EDITABLE.has(dist.status)) throw fail(`This distribution is ${STATUS_LABEL[dist.status].toLowerCase()} and cannot be changed`, 409);
    if (Number(revision) !== dist.revision) throw fail("The distribution was changed by another officer since you opened it. Reload to see the latest figures.", 409, { code: "stale", revision: dist.revision });
    const log = [];
    const rows = new Map((await CeilingAllocation.findAll({ where: { distribution_id: dist.id }, transaction })).map((r) => [r.organization, r]));
    for (const c of changes) {
      if (!names.has(c.organization)) throw fail(`${c.organization} is not an active DAD`);
      if (!CEILING_KEYS.includes(c.key)) throw fail("Unknown classification");
      const cents = c.cents === null || c.cents === undefined || c.cents === "" ? null : Number(c.cents);
      if (cents !== null && (!Number.isInteger(cents) || cents < 0 || cents >= MAX_CENTS)) throw fail(`${c.organization} · ${KEY_LABEL[c.key]}: enter an amount of zero or more`);
      let row = rows.get(c.organization);
      if (!row) {
        row = await CeilingAllocation.create({ distribution_id: dist.id, organization: c.organization, updated_by: user.name }, { transaction });
        rows.set(c.organization, row);
      }
      const before = toCents(row[c.key]);
      if (before === cents) continue;
      row.set(c.key, fromCents(cents));
      row.set("updated_by", user.name);
      log.push(`${c.organization} · ${KEY_LABEL[c.key]}: ${before === null ? "blank" : fromCents(before)} → ${cents === null ? "blank" : fromCents(cents)}`);
    }
    for (const row of rows.values()) if (row.changed()) await row.save({ transaction });
    await dist.update({ revision: dist.revision + 1, updated_by: user.name, updated_by_id: user.id }, { transaction });
    if (log.length) await logWorkflowEvent({ entityType: ENTITY, record: dist, action: "allocate", from: dist.status, to: dist.status, comment: log.join("\n").slice(0, 4000), user });
    return { revision: dist.revision, updatedAt: dist.updated_at, updatedBy: user.name };
  });
}

/* ---------- workflow ---------- */

const STEPS = {
  submit: { from: ["Draft", "Returned"], to: "PendingRecommendation", permission: "ceilings.prepare", label: "submitted for review" },
  recommend: { from: ["PendingRecommendation"], to: "PendingEndorsement", permission: "ceilings.recommend", label: "recommended" },
  endorse: { from: ["PendingEndorsement"], to: "PendingApproval", permission: "ceilings.endorse", label: "endorsed" },
  approve: { from: ["PendingApproval"], to: "Approved", permission: "ceilings.approve", label: "approved" },
};
const STAGE_ACTOR = { PendingRecommendation: "ceilings.recommend", PendingEndorsement: "ceilings.endorse", PendingApproval: "ceilings.approve" };
const NEXT_PERMISSION = { submit: "ceilings.recommend", recommend: "ceilings.endorse", endorse: "ceilings.approve" };

/** Notify active users whose role holds `permission` (excluding the actor). */
async function notifyPermission(permission, { record, actorId, message, event }) {
  try {
    const roles = [];
    for (const role of ROLES) if (role !== "admin" && (await permissionsForRole(role))[permission]) roles.push(role);
    if (!roles.length) return;
    const users = await User.findAll({ where: { role: { [Op.in]: roles }, status: "active", ...(actorId ? { id: { [Op.ne]: actorId } } : {}) }, attributes: ["id"] });
    if (users.length) await Notification.bulkCreate(users.map((u) => ({ userId: u.id, organization: "PCMED", actorId, entityType: ENTITY, entityId: record.id, event, message })));
  } catch (error) {
    console.error("Budget ceiling notification failed:", error);
  }
}

export async function advance(user, id, action, { comment, revision }) {
  const step = STEPS[action];
  if (!step) throw fail("Unknown action");
  await assertCan(user, step.permission);
  const result = await sequelize.transaction(async (transaction) => {
    const dist = await loadDistribution(id, transaction);
    const from = dist.status;
    if (!step.from.includes(from)) throw fail(`This distribution is ${STATUS_LABEL[from].toLowerCase()}; it cannot be ${step.label} now`, 409);
    if (revision !== undefined && revision !== null && Number(revision) !== dist.revision)
      throw fail("The distribution changed since you opened it. Reload and check it before continuing.", 409, { code: "stale", revision: dist.revision });
    // Segregation of duties: nobody acts twice on the same submission.
    const prior = [dist.submitted_by_id, dist.recommended_by_id, dist.endorsed_by_id].filter(Boolean);
    if (action !== "submit" && prior.includes(user.id)) throw fail("You have already acted on this distribution; another officer must take this step", 403);

    // Revalidate the exact version at every step.
    const state = await describe(dist, transaction);
    if (state.validation.errors.length) throw fail(`The distribution has ${state.validation.errors.length} issue${state.validation.errors.length === 1 ? "" : "s"} to resolve`, 400, { validation: state.validation });

    const note = String(comment ?? "").trim() || null;
    const now = new Date();
    const changes = { status: step.to, revision: dist.revision + 1 };
    if (action === "submit")
      Object.assign(changes, {
        submitted_by: user.name,
        submitted_by_id: user.id,
        submitted_at: now,
        submitted_comment: note,
        recommended_by: null,
        recommended_by_id: null,
        recommended_at: null,
        recommended_comment: null,
        endorsed_by: null,
        endorsed_by_id: null,
        endorsed_at: null,
        endorsed_comment: null,
        return_reason: null,
        returned_stage: null,
        // The requirements used for this distribution stay identifiable through approval.
        requirements_snapshot: state.requirements,
      });
    if (action === "recommend") Object.assign(changes, { recommended_by: user.name, recommended_by_id: user.id, recommended_at: now, recommended_comment: note });
    if (action === "endorse") Object.assign(changes, { endorsed_by: user.name, endorsed_by_id: user.id, endorsed_at: now, endorsed_comment: note });
    if (action === "approve") Object.assign(changes, { approved_by: user.name, approved_by_id: user.id, approved_at: now, approved_comment: note });
    await dist.update(changes, { transaction });
    if (action === "submit")
      await CeilingDistributionVersion.create(
        { distribution_id: dist.id, revision: dist.revision, status: dist.status, snapshot: { ceiling: state.ceiling, allocations: state.allocations, requirements: state.requirements }, created_by: user.name, created_by_id: user.id },
        { transaction },
      );
    if (action === "approve") await createDadCeilings(dist, state, user, transaction);
    return { dist, from, note };
  });
  const { dist, from, note } = result;
  await logWorkflowEvent({ entityType: ENTITY, record: dist, action, from, to: dist.status, comment: note, user });
  const what = `the FY ${dist.year} budget ceiling distribution (version ${dist.version})`;
  if (NEXT_PERMISSION[action]) await notifyPermission(NEXT_PERMISSION[action], { record: dist, actorId: user.id, message: `${user.name} ${step.label} ${what}`, event: action === "submit" ? (from === "Returned" ? "resubmitted" : "created") : "reviewed" });
  if (action === "approve") {
    await notifyPermission("ceilings.prepare", { record: dist, actorId: user.id, message: `${user.name} approved ${what}; DAD ceilings are being communicated`, event: "approved" });
    await communicate(dist, user);
  }
  return describe(dist);
}

export async function returnDistribution(user, id, { comment }) {
  const note = String(comment ?? "").trim();
  if (!note) throw fail("Give the reason for returning the distribution");
  const dist = await loadDistribution(id);
  const from = dist.status;
  const permission = STAGE_ACTOR[from];
  if (!permission) throw fail(`A distribution that is ${STATUS_LABEL[from].toLowerCase()} cannot be returned`, 409);
  await assertCan(user, permission);
  await dist.update({ status: "Returned", return_reason: note, returned_by: user.name, returned_by_id: user.id, returned_at: new Date(), returned_stage: from, revision: dist.revision + 1 });
  await logWorkflowEvent({ entityType: ENTITY, record: dist, action: "return", from, to: "Returned", comment: note, user });
  await notifyPermission("ceilings.prepare", { record: dist, actorId: user.id, message: `${user.name} returned the FY ${dist.year} budget ceiling distribution: ${note}`, event: "returned" });
  return describe(dist);
}

/* ---------- final approval: publication, Revised Work Plans, notification ---------- */

async function createDadCeilings(dist, state, user, transaction) {
  const codes = new Map(state.organizations.map((o) => [o.name, o.code]));
  for (const a of state.allocations) {
    const exists = await DadCeiling.findOne({ where: { distribution_id: dist.id, organization: a.organization }, transaction });
    if (exists) continue; // never duplicated
    await DadCeiling.create(
      {
        distribution_id: dist.id,
        year: dist.year,
        organization: a.organization,
        ...Object.fromEntries(CEILING_KEYS.map((k) => [k, fromCents(a.amounts[k] ?? 0)])),
        approved_by: user.name,
        approved_at: dist.approved_at,
        communication_reference: `BC/${dist.year}/V${dist.version}/${(codes.get(a.organization) || a.organization).replace(/[^\w-]+/g, "")}`.slice(0, 160),
        published_at: new Date(),
      },
      { transaction },
    );
  }
}

/** Copy the Initial Work Plan into a Revised Work Plan bound to the DAD's ceiling (once). */
async function activateRevisedPlan(dc) {
  return sequelize.transaction(async (transaction) => {
    let revised = await WorkPlan.findOne({ where: { organization: dc.organization, year: dc.year, stage: "Revised" }, transaction, lock: transaction.LOCK.UPDATE });
    if (revised) {
      if (revised.ceiling_id !== dc.id) await revised.update({ ceiling_id: dc.id }, { transaction });
      return revised;
    }
    const initial = await WorkPlan.findOne({ where: { organization: dc.organization, year: dc.year, stage: "Initial" }, transaction });
    revised = await WorkPlan.create(
      { organization: dc.organization, year: dc.year, stage: "Revised", parent_plan_id: initial?.id ?? null, status: "Draft", revision: 0, activated_revision: 0, ceiling_id: dc.id, created_by: "BITS (ceiling communication)", updated_by: "BITS (ceiling communication)" },
      { transaction },
    );
    if (initial) {
      const outputs = await WorkPlanOutput.findAll({
        where: { work_plan_id: initial.id },
        include: [{ model: WorkPlanActivity, as: "activities", include: [{ model: WorkPlanQuarterActivity, as: "quarters", include: [{ model: WorkPlanCostItem, as: "items" }] }] }],
        transaction,
      });
      for (const o of outputs) {
        const no = await WorkPlanOutput.create({ work_plan_id: revised.id, origin_id: o.id, objective_id: o.objective_id, output: o.output, means_of_verification: o.means_of_verification, sort: o.sort, created_by: o.created_by, updated_by: o.updated_by }, { transaction });
        for (const a of o.activities) {
          const na = await WorkPlanActivity.create({ output_id: no.id, origin_id: a.id, description: a.description, sort: a.sort, created_by: a.created_by, updated_by: a.updated_by }, { transaction });
          for (const q of a.quarters) {
            const nq = await WorkPlanQuarterActivity.create({ activity_id: na.id, origin_id: q.id, quarter: q.quarter, description: q.description, no_cost: q.no_cost, sort: q.sort, created_by: q.created_by, updated_by: q.updated_by }, { transaction });
            if (q.items.length)
              await WorkPlanCostItem.bulkCreate(
                q.items.map((i) => ({
                  quarter_activity_id: nq.id,
                  natural_account_id: i.natural_account_id,
                  description: i.description,
                  funding_source: i.funding_source,
                  unit_of_measure: i.unit_of_measure,
                  costing_method: i.costing_method,
                  quantity: i.quantity,
                  unit_cost: i.unit_cost,
                  frequency: i.frequency,
                  amount: i.amount,
                  origin_id: i.id,
                  sort: i.sort,
                  created_by: i.created_by,
                  updated_by: i.updated_by,
                })),
                { transaction },
              );
          }
        }
      }
    }
    return revised;
  });
}

/** Activate and notify each published DAD ceiling; failures are recorded per DAD and can be retried. */
async function communicate(dist, user) {
  const ceilings = await DadCeiling.findAll({ where: { distribution_id: dist.id, activation_status: { [Op.ne]: "activated" } } });
  for (const dc of ceilings) {
    try {
      const plan = await activateRevisedPlan(dc);
      await dc.update({ work_plan_id: plan.id, activation_status: "activated", activation_error: null });
      await logWorkflowEvent({ entityType: "workPlan", record: plan, action: "activated", from: null, to: plan.status, comment: `Revised Work Plan activated with ceiling ${dc.communication_reference}`, user });
    } catch (error) {
      console.error(`Revised Work Plan activation failed for ${dc.organization}:`, error);
      await dc.update({ activation_status: "failed", activation_error: String(error.message || error).slice(0, 1000) });
      continue;
    }
    if (!dc.notified_at) {
      try {
        await notifyOrganization({ organization: dc.organization, actorId: user.id, entityType: ENTITY, entityId: dist.id, event: "approved", message: `${user.name} approved your FY ${dc.year} budget ceiling (${dc.communication_reference}). Your Revised Work Plan is open for revision.` });
        await dc.update({ notified_at: new Date() });
      } catch (error) {
        console.error(`Ceiling notification failed for ${dc.organization}:`, error);
      }
    }
  }
  await logWorkflowEvent({ entityType: ENTITY, record: dist, action: "communicated", from: "Approved", to: "Approved", comment: `${ceilings.length} DAD ceiling${ceilings.length === 1 ? "" : "s"} processed`, user });
}

/** Retry publication steps that failed, without a new approval. */
export async function retryCommunication(user, id) {
  await assertCan(user, "ceilings.prepare");
  const dist = await loadDistribution(id);
  if (dist.status !== "Approved") throw fail("Only an approved distribution is communicated", 409);
  await communicate(dist, user);
  return describe(dist);
}

/* ---------- DAD view ---------- */

export async function myCeiling(user, { year, organization }) {
  const y = validYear(year);
  const org = user.organization || organization;
  if (!org) throw fail("Your account is not assigned to a DAD", 403);
  if (organization && organization !== user.organization && !(await can(user, "ceilings.prepare")) && user.role !== "admin") throw fail("You can only see your own DAD's ceiling", 403);
  const dc = await DadCeiling.findOne({ where: { organization: org, year: y }, order: [["id", "DESC"]] });
  if (!dc) return { ceiling: null, organization: org };
  const plan = dc.work_plan_id ? await WorkPlan.findByPk(dc.work_plan_id) : null;
  return { ceiling: dadCeilingDto(dc), organization: org, plan: plan && { id: plan.id, status: plan.status, stage: plan.stage } };
}

export async function acknowledge(user, dadCeilingId) {
  const dc = await DadCeiling.findByPk(dadCeilingId);
  if (!dc) throw fail("Ceiling not found", 404);
  if (dc.organization !== user.organization) throw fail("Only officers of the DAD can acknowledge its ceiling", 403);
  if (!dc.acknowledged_at) {
    await dc.update({ acknowledged_at: new Date(), acknowledged_by: user.name });
    await logWorkflowEvent({ entityType: ENTITY, record: { id: dc.distribution_id, organization: dc.organization }, action: "acknowledged", from: "Approved", to: "Approved", comment: `${dc.organization} acknowledged receipt of ${dc.communication_reference}`, user });
  }
  return dadCeilingDto(dc);
}

/* ---------- Revision Monitoring ---------- */

/** The Revised Work Plan's state in monitoring terms (independent of financial compliance). */
export function revisionStatus(plan) {
  if (!plan) return "NotStarted";
  if (plan.status === "Draft") return plan.revision > (plan.activated_revision ?? 0) ? "InProgress" : "NotStarted";
  return { PendingReview: "PendingInternalReview", PendingApproval: "PendingInternalApproval", SubmittedToPCMED: "Submitted", UnderVerification: "UnderReview", Returned: "Returned", Verified: "Verified" }[plan.status];
}

/** Revised requirement of a plan by ceiling key, from its live costing records. */
export async function planRequirement(planId, accounts) {
  const items = await WorkPlanCostItem.findAll({
    include: [{ model: WorkPlanQuarterActivity, as: "quarterActivity", required: true, include: [{ model: WorkPlanActivity, as: "activityRecord", required: true, include: [{ model: WorkPlanOutput, as: "outputRecord", required: true, where: { work_plan_id: planId } }] }] }],
  });
  const amounts = Object.fromEntries(CEILING_KEYS.map((k) => [k, 0]));
  let unclassified = 0;
  for (const i of items) {
    const key = ceilingKey(i.funding_source, accounts.get(i.natural_account_id)?.economic_classification);
    if (key) amounts[key] += toCents(i.amount);
    else unclassified += toCents(i.amount);
  }
  return { amounts, unclassified, items: items.length };
}

/** Per classification: requirement within the DAD's ceiling? (aggregate balance alone is not enough) */
export function compliance(ceilingAmounts, req) {
  const exceeded = CEILING_KEYS.filter((k) => req.amounts[k] > (ceilingAmounts[k] ?? 0)).map((k) => ({ key: k, label: KEY_LABEL[k], ceiling: ceilingAmounts[k] ?? 0, requirement: req.amounts[k] }));
  if (req.unclassified > 0) exceeded.push({ key: "unclassified", label: "Costing outside the ceiling classifications (e.g. FLG Compensation of Employees)", ceiling: 0, requirement: req.unclassified });
  return { state: exceeded.length ? "Exceeded" : "Within", exceeded };
}

export async function monitoring(user, { year }) {
  const y = validYear(year);
  const dist = await CeilingDistribution.findOne({ where: { year: y, status: "Approved" }, order: [["version", "DESC"]] });
  if (!dist) return { approved: false, rows: [] };
  const accounts = await accountMap();
  const ceilings = await DadCeiling.findAll({ where: { distribution_id: dist.id }, order: [["organization", "ASC"]] });
  const rows = [];
  for (const dc of ceilings) {
    const plan = dc.work_plan_id ? await WorkPlan.findByPk(dc.work_plan_id) : null;
    const status = revisionStatus(plan);
    const req = plan ? await planRequirement(plan.id, accounts) : null;
    const amounts = centsRow(dc);
    const assessed = req && req.items > 0;
    rows.push({
      id: dc.id,
      organization: dc.organization,
      ceiling: dadCeilingDto(dc),
      approvedCents: sum(CEILING_KEYS.map((k) => amounts[k])),
      requirement: assessed ? req : null,
      requirementCents: assessed ? sum(CEILING_KEYS.map((k) => req.amounts[k])) + req.unclassified : null,
      requirementState: !assessed ? "unavailable" : plan.status === "Verified" ? "verified" : ["SubmittedToPCMED", "UnderVerification"].includes(plan.status) ? "submitted" : "draft",
      status,
      compliance: assessed ? compliance(amounts, req) : { state: "NotAssessed", exceeded: [] },
      plan: plan && { id: plan.id, status: plan.status, revision: plan.revision, submittedAt: plan.submitted_at, returnReason: plan.return_reason },
    });
  }
  return { approved: true, distribution: distDto(dist), rows };
}

export async function history(user, id) {
  const dist = await loadDistribution(id);
  const [events, versions, ceilings] = await Promise.all([
    workflowHistory(ENTITY, dist.id),
    CeilingDistributionVersion.findAll({ where: { distribution_id: dist.id }, attributes: ["id", "revision", "status", "created_by", "created_at"], order: [["id", "ASC"]] }),
    MinistryCeiling.findAll({ where: { year: dist.year }, order: [["version", "ASC"]] }),
  ]);
  return {
    events,
    versions: versions.map((v) => ({ id: v.id, revision: v.revision, status: v.status, by: v.created_by, at: v.created_at })),
    ministryCeilings: ceilings.map((c) => ({ id: c.id, version: c.version, reference: c.reference, communicatedOn: c.communicated_on, amendmentReason: c.amendment_reason, totalCents: sum(CEILING_KEYS.map((k) => toCents(c[k]))), documentId: c.document_id, by: c.created_by, at: c.created_at })),
  };
}

/** Distributions awaiting the user's step (for the Review Workbench). */
export async function awaitingMe(user) {
  const statuses = [];
  for (const [status, permission] of Object.entries(STAGE_ACTOR)) if (await can(user, permission)) statuses.push(status);
  if (!statuses.length) return [];
  const rows = await CeilingDistribution.findAll({ where: { status: statuses }, order: [["year", "DESC"]] });
  return rows.map(distDto);
}

export { FUNDS, CEILING_KEYS, KEY_LABEL };
