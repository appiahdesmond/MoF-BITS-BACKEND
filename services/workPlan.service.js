// Work Plan: Adopted Objective → Main Output → Annual Activity → Quarterly Activity → Cost Item.
// One plan per DAD and financial year (stage "Initial"; "Revised" is reserved for the revision
// after budget ceilings are communicated). Every write checks the user's permission, the DAD
// scope, that the plan is still editable and that the client saw the latest revision; amounts
// are always recalculated here from the cost drivers.
import { Op } from "sequelize";
import sequelize from "../config/database.js";
import {
  NaturalAccount,
  StrategicObjective,
  WorkPlan,
  WorkPlanActivity,
  WorkPlanCostItem,
  WorkPlanOutput,
  WorkPlanQuarterActivity,
  WorkPlanVersion,
  WorkPlanDecision,
  WorkPlanObservation,
} from "../models/workPlan.model.js";
import { compareTrees } from "../utils/workPlanCompare.js";
import { COSTING_METHODS, FUNDING_SOURCES, itemCents, validateTree } from "../utils/workPlanCalc.js";
import { notifyPcmedStep } from "../utils/notify.js";
import { dadScope, inScope, seesAllDads } from "../utils/dataScope.js";
import { logWorkflowEvent, workflowHistory } from "../utils/workflowLog.js";
import { permissionsForRole } from "../utils/permissions.js";
import { DadCeiling } from "../models/budgetCeiling.model.js";
import { CEILING_KEYS, KEY_LABEL, ceilingKey, centsRow } from "../utils/ceilingKeys.js";

const EDITABLE = new Set(["Draft", "Returned"]);
const MAX_CENTS = 1e15;
const fail = (message, statusCode = 400, extra = {}) => Object.assign(new Error(message), { statusCode, ...extra });
const toCents = (v) => Math.round(Number(v || 0) * 100);
const text = (v, max) => {
  const s = String(v ?? "").trim();
  if (s.length > max) throw fail(`Text is limited to ${max} characters`);
  return s;
};
const STATUS_LABEL = {
  Draft: "Draft",
  PendingReview: "Pending Review",
  PendingApproval: "Pending Approval",
  SubmittedToPCMED: "Submitted to PCMED",
  UnderVerification: "Under Verification",
  Returned: "Returned for Correction",
  Verified: "Verified",
};

const validYear = (row, year) => (!row.valid_from_year || row.valid_from_year <= year) && (!row.valid_to_year || row.valid_to_year >= year);

/* ---------- reference data (central registers) ---------- */

async function registers(year) {
  const [accounts, objectives] = await Promise.all([NaturalAccount.findAll({ order: [["code", "ASC"]] }), StrategicObjective.findAll({ order: [["code", "ASC"]] })]);
  return { accounts: new Map(accounts.map((a) => [a.id, a])), objectives: new Map(objectives.map((o) => [o.id, o])), year };
}

/** Selectable values for a financial year: valid posting accounts, active objectives, funding sources, costing methods. */
export async function referenceData(year) {
  const y = Number(year);
  const { accounts, objectives } = await registers(y);
  return {
    naturalAccounts: [...accounts.values()]
      .filter((a) => a.status === "active" && a.is_posting && validYear(a, y))
      .map((a) => ({ id: a.id, code: a.code, description: a.description, economicClassification: a.economic_classification })),
    objectives: [...objectives.values()].filter((o) => o.status === "active" && validYear(o, y)).map((o) => ({ id: o.id, code: o.code, objective: o.objective })),
    fundingSources: FUNDING_SOURCES,
    costingMethods: Object.entries(COSTING_METHODS).map(([key, m]) => ({ key, label: m.label, drivers: m.drivers })),
  };
}

/* ---------- reading ---------- */

function resolveOrganization(user, requested) {
  if (seesAllDads(user) || user.data_scope === "assigned") {
    if (!requested) throw fail("Choose a DAD");
    return requested;
  }
  if (!user.organization) throw fail("Your account is not assigned to a DAD", 403);
  return user.organization;
}
async function assertScope(user, organization) {
  if (!inScope(await dadScope(user), organization)) throw fail("This work plan belongs to a DAD outside your data scope", 403);
}

const planDto = (p) => ({
  id: p.id,
  organization: p.organization,
  year: p.year,
  stage: p.stage,
  ceilingId: p.ceiling_id,
  parentPlanId: p.parent_plan_id,
  status: p.status,
  revision: p.revision,
  submittedBy: p.submitted_by,
  submittedById: p.submitted_by_id,
  submittedAt: p.submitted_at,
  recommendedById: p.recommended_by_id,
  reviewedById: p.reviewed_by_id,
  returnReason: p.return_reason,
  returnedBy: p.returned_by,
  returnedAt: p.returned_at,
  updatedBy: p.updated_by,
  updatedAt: p.updated_at,
});

async function loadTree(planId, transaction) {
  const outputs = await WorkPlanOutput.findAll({
    where: { work_plan_id: planId },
    include: [
      {
        model: WorkPlanActivity,
        as: "activities",
        include: [{ model: WorkPlanQuarterActivity, as: "quarters", include: [{ model: WorkPlanCostItem, as: "items" }] }],
      },
    ],
    order: [
      ["sort", "ASC"],
      ["id", "ASC"],
      [{ model: WorkPlanActivity, as: "activities" }, "sort", "ASC"],
      [{ model: WorkPlanActivity, as: "activities" }, "id", "ASC"],
      [{ model: WorkPlanActivity, as: "activities" }, { model: WorkPlanQuarterActivity, as: "quarters" }, "quarter", "ASC"],
      [{ model: WorkPlanActivity, as: "activities" }, { model: WorkPlanQuarterActivity, as: "quarters" }, "sort", "ASC"],
      [{ model: WorkPlanActivity, as: "activities" }, { model: WorkPlanQuarterActivity, as: "quarters" }, "id", "ASC"],
      [{ model: WorkPlanActivity, as: "activities" }, { model: WorkPlanQuarterActivity, as: "quarters" }, { model: WorkPlanCostItem, as: "items" }, "sort", "ASC"],
      [{ model: WorkPlanActivity, as: "activities" }, { model: WorkPlanQuarterActivity, as: "quarters" }, { model: WorkPlanCostItem, as: "items" }, "id", "ASC"],
    ],
    transaction,
  });
  return outputs.map((o) => ({
    id: o.id,
    originId: o.origin_id,
    objectiveId: o.objective_id,
    output: o.output,
    meansOfVerification: o.means_of_verification ?? "",
    updatedBy: o.updated_by,
    updatedAt: o.updated_at,
    activities: o.activities.map((a) => ({
      id: a.id,
      originId: a.origin_id,
      description: a.description,
      revisionReason: a.revision_reason ?? "",
      reasonBasisCents: a.reason_basis_cents === null ? null : Number(a.reason_basis_cents),
      updatedBy: a.updated_by,
      updatedAt: a.updated_at,
      quarters: a.quarters.map((q) => ({
        id: q.id,
        originId: q.origin_id,
        quarter: q.quarter,
        description: q.description ?? "",
        noCost: q.no_cost,
        items: q.items.map((i) => ({
          id: i.id,
          originId: i.origin_id,
          revisionReason: i.revision_reason ?? "",
          naturalAccountId: i.natural_account_id,
          description: i.description ?? "",
          fundingSource: i.funding_source,
          unitOfMeasure: i.unit_of_measure ?? "",
          costingMethod: i.costing_method,
          quantity: i.quantity === null ? null : Number(i.quantity),
          unitCost: i.unit_cost === null ? null : Number(i.unit_cost),
          frequency: i.frequency === null ? null : Number(i.frequency),
          amountCents: toCents(i.amount),
          copiedFromId: i.copied_from_id,
          updatedBy: i.updated_by,
          updatedAt: i.updated_at,
        })),
      })),
    })),
  }));
}

/**
 * A Revised Work Plan is bound to the DAD's approved ceiling: each of the eight
 * classifications is checked on its own (a balanced total does not mean compliance).
 */
const classify = (outputs, accounts) => {
  const used = Object.fromEntries(CEILING_KEYS.map((k) => [k, 0]));
  let unclassified = 0;
  for (const o of outputs)
    for (const a of o.activities)
      for (const q of a.quarters)
        for (const i of q.items) {
          const key = ceilingKey(i.fundingSource, accounts.get(i.naturalAccountId)?.economic_classification);
          if (key) used[key] += i.amountCents;
          else if (i.naturalAccountId && i.fundingSource) unclassified += i.amountCents;
        }
  return { used, unclassified };
};

async function ceilingCheck(plan, outputs, accounts, transaction, baseline) {
  if (plan.stage !== "Revised" || !plan.ceiling_id) return null;
  const dc = await DadCeiling.findByPk(plan.ceiling_id, { transaction });
  if (!dc) return null;
  const limit = centsRow(dc);
  const { used, unclassified } = classify(outputs, accounts);
  const gh = (c) => (c / 100).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Each classification on its own: over the ceiling blocks, and (Ministry policy, 27 Nov 2026)
  // every ceiling must be fully used, so an unused balance blocks too.
  const errors = CEILING_KEYS.filter((k) => used[k] !== limit[k]).map((k) =>
    used[k] > limit[k]
      ? { code: "ceiling", key: k, message: `${KEY_LABEL[k]} exceeds the approved ceiling by GH₵${gh(used[k] - limit[k])}` }
      : { code: "ceilingUnused", key: k, message: `${KEY_LABEL[k]}: GH₵${gh(limit[k] - used[k])} of the approved ceiling is not yet used (all ceilings must be fully used)` },
  );
  if (unclassified) errors.push({ code: "ceiling", key: "unclassified", message: "Some costing has no ceiling (FLG cannot fund Compensation of Employees)" });
  const initial = baseline ? classify(baseline, accounts).used : null;
  return { reference: dc.communication_reference, approvedAt: dc.approved_at, acknowledgedAt: dc.acknowledged_at, ceilingId: dc.id, limit, used, initial, unclassified, errors };
}

async function decisionMap(planId, transaction) {
  const rows = await WorkPlanDecision.findAll({ where: { work_plan_id: planId }, transaction });
  return new Map(rows.map((d) => [`${d.record_type}:${d.origin_id}`, { decision: d.decision, reason: d.reason, by: d.created_by, at: d.created_at }]));
}

/** Revised Work Plan against its Initial baseline: comparison and the revision rules. */
async function revisionState(plan, outputs, accounts, transaction) {
  if (plan.stage !== "Revised") return null;
  const baseline = plan.parent_plan_id ? await loadTree(plan.parent_plan_id, transaction) : [];
  const decisions = await decisionMap(plan.id, transaction);
  const compare = compareTrees({ kind: "initial", outputs: baseline }, { kind: "revised", outputs }, { accounts, decisions });
  const errors = [];
  const warnings = [];
  for (const o of compare.tree)
    for (const a of o.children) {
      if (!a.id) continue; // removed or deferred: the reason was recorded with the decision
      const at = { outputId: o.id, activityId: a.id };
      const act = outputs.find((x) => x.id === o.id)?.activities.find((x) => x.id === a.id);
      const name = (a.targetLabel || "Untitled activity").slice(0, 80);
      if (a.type !== "Retained" && !act?.revisionReason?.trim())
        errors.push({ ...at, code: "justification", message: `${name}: give the revision justification (${a.type.toLowerCase()}${a.attrs.length ? `, ${a.attrs.join(", ").toLowerCase()}` : ""})` });
      else if (a.type !== "Retained" && act?.reasonBasisCents !== null && act?.reasonBasisCents !== undefined && act.reasonBasisCents !== a.targetCents)
        errors.push({ ...at, code: "justificationReview", message: `${name}: the costing changed after the justification was written; review the justification` });
      if (a.baseCents > 0 && a.targetCents < a.baseCents / 2) warnings.push({ ...at, code: "reduction", message: `${name}: reduced by more than half; check the deliverable is still achievable` });
    }
  return { baseline, compare, decisions: [...decisions.entries()].map(([k, v]) => ({ key: k, ...v })), errors, warnings };
}

async function describe(plan, transaction) {
  const outputs = await loadTree(plan.id, transaction);
  const regs = await registers(plan.year);
  const validation = validateTree({ outputs, ...regs });
  validation.warnings = [];
  const revision = await revisionState(plan, outputs, regs.accounts, transaction);
  const ceiling = await ceilingCheck(plan, outputs, regs.accounts, transaction, revision?.baseline);
  if (ceiling) validation.errors.push(...ceiling.errors);
  if (revision) {
    validation.errors.push(...revision.errors);
    validation.warnings.push(...revision.warnings);
  }
  const observations = await WorkPlanObservation.findAll({ where: { work_plan_id: plan.id }, order: [["id", "DESC"]], transaction });
  return {
    plan: planDto(plan),
    outputs,
    validation,
    ceiling,
    revision,
    observations: observations.map((x) => ({ id: x.id, recordType: x.record_type, recordId: x.record_id, recordLabel: x.record_label, stage: x.stage, text: x.text, by: x.created_by, role: x.created_by_role, at: x.created_at, resolvedAt: x.resolved_at })),
  };
}

export async function getPlan(user, { year, organization: requested }) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw fail("Choose a valid financial year");
  const organization = resolveOrganization(user, requested);
  await assertScope(user, organization);
  const years = (await WorkPlan.findAll({ where: { organization }, attributes: ["year"], raw: true })).map((r) => r.year);
  let plan = await WorkPlan.findOne({ where: { organization, year: y }, order: [["stage", "DESC"]] }); // the Revised plan when there is one
  if (!plan) {
    if (!(await permissionsForRole(user.role))["workPlan.edit"]) return { plan: null, notStarted: true, outputs: [], organization, years, validation: { errors: [] } };
    plan = await WorkPlan.create({ organization, year: y, status: "Draft", created_by: user.name, created_by_id: user.id, updated_by: user.name, updated_by_id: user.id });
    await logWorkflowEvent({ entityType: "workPlan", record: plan, action: "created", from: null, to: "Draft", user });
  }
  return { ...(await describe(plan)), organization, years: [...new Set([...years, y])].sort((a, b) => b - a) };
}

async function loadPlanForUser(user, id, transaction) {
  const plan = await WorkPlan.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!plan) throw fail("Work plan not found", 404);
  await assertScope(user, plan.organization);
  return plan;
}

/* ---------- editing ---------- */

/** Lock the plan, check it may be changed by this user, and that the client saw the latest revision. */
async function openForEdit(user, id, revision, transaction) {
  if (!(await permissionsForRole(user.role))["workPlan.edit"]) throw fail("Your role cannot change work plans", 403);
  const plan = await loadPlanForUser(user, id, transaction);
  if (!EDITABLE.has(plan.status)) throw fail(`This work plan is ${STATUS_LABEL[plan.status].toLowerCase()} and cannot be changed`, 409);
  if (plan.stage === "Initial" && (await WorkPlan.count({ where: { organization: plan.organization, year: plan.year, stage: "Revised" }, transaction })))
    throw fail("The Initial Work Plan is the baseline of the Revised Work Plan and cannot be changed", 409);
  if (Number(revision) !== plan.revision)
    throw fail("This work plan was changed by someone else since you opened it. Reload to see the latest version.", 409, { code: "stale", revision: plan.revision });
  return plan;
}
async function bump(plan, user, transaction) {
  await plan.update({ revision: plan.revision + 1, updated_by: user.name, updated_by_id: user.id }, { transaction });
}
async function outputOf(plan, outputId, transaction) {
  const o = await WorkPlanOutput.findOne({ where: { id: outputId, work_plan_id: plan.id }, transaction });
  if (!o) throw fail("Main Output not found in this work plan", 404);
  return o;
}
async function activityOf(plan, activityId, transaction) {
  const a = await WorkPlanActivity.findByPk(activityId, { include: [{ model: WorkPlanOutput, as: "outputRecord", where: { work_plan_id: plan.id } }], transaction });
  if (!a) throw fail("Annual activity not found in this work plan", 404);
  return a;
}
async function checkObjective(id, year) {
  if (id === null || id === undefined || id === "") throw fail("Choose the Adopted Objective");
  const o = await StrategicObjective.findByPk(Number(id));
  if (!o || o.status !== "active" || !validYear(o, year)) throw fail("Choose an active Adopted Objective for this financial year");
  return o.id;
}

export async function saveOutput(user, id, outputId, { revision, objectiveId, output, meansOfVerification }) {
  return sequelize.transaction(async (transaction) => {
    const plan = await openForEdit(user, id, revision, transaction);
    const values = {
      objective_id: await checkObjective(objectiveId, plan.year),
      output: text(output, 2000),
      means_of_verification: text(meansOfVerification, 2000),
      updated_by: user.name,
    };
    if (!values.output) throw fail("Enter the Main Output / Key Deliverable");
    let row;
    if (outputId) {
      row = await outputOf(plan, outputId, transaction);
      await row.update(values, { transaction });
    } else {
      const sort = (await WorkPlanOutput.max("sort", { where: { work_plan_id: plan.id }, transaction })) ?? 0;
      row = await WorkPlanOutput.create({ ...values, work_plan_id: plan.id, sort: sort + 1, created_by: user.name }, { transaction });
    }
    await bump(plan, user, transaction);
    return { ...(await describe(plan, transaction)), outputId: row.id };
  });
}

export async function deleteOutput(user, id, outputId, { revision }) {
  return sequelize.transaction(async (transaction) => {
    const plan = await openForEdit(user, id, revision, transaction);
    const row = await outputOf(plan, outputId, transaction);
    await row.destroy({ transaction }); // activities, quarterly activities and cost items go with it
    await bump(plan, user, transaction);
    return describe(plan, transaction);
  });
}

export async function deleteActivity(user, id, activityId, { revision }) {
  return sequelize.transaction(async (transaction) => {
    const plan = await openForEdit(user, id, revision, transaction);
    const row = await activityOf(plan, activityId, transaction);
    await row.destroy({ transaction });
    await bump(plan, user, transaction);
    return describe(plan, transaction);
  });
}

const num = (v, label, max) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw fail(`${label} must be zero or more`);
  if (n > max) throw fail(`${label} is too large`);
  return n;
};

/** Cost item values from the client, checked and with the amount recalculated. */
async function cleanItem(raw, year) {
  const method = COSTING_METHODS[raw.costingMethod] ? raw.costingMethod : "quantity";
  let accountId = raw.naturalAccountId ? Number(raw.naturalAccountId) : null;
  if (accountId) {
    const a = await NaturalAccount.findByPk(accountId);
    if (!a || a.status !== "active" || !a.is_posting || !validYear(a, year)) throw fail("Choose a valid posting Natural Account for this financial year");
  }
  const funding = raw.fundingSource ? String(raw.fundingSource) : null;
  if (funding && !FUNDING_SOURCES.some((f) => f.code === funding)) throw fail(`Unknown funding source: ${funding}`);
  const item = {
    natural_account_id: accountId,
    description: text(raw.description, 500),
    funding_source: funding,
    unit_of_measure: text(raw.unitOfMeasure, 60) || null,
    costing_method: method,
    quantity: num(raw.quantity, "Quantity", 1e9),
    unit_cost: num(raw.unitCost, "Unit cost", 1e12),
    frequency: num(raw.frequency ?? 1, "Frequency", 1e6),
  };
  if (item.unit_cost !== null) item.unit_cost = Math.round(item.unit_cost * 100) / 100;
  const cents = itemCents({ costingMethod: method, quantity: item.quantity, unitCost: item.unit_cost, frequency: item.frequency }) ?? 0;
  if (cents >= MAX_CENTS) throw fail("The estimated cost is too large");
  item.amount = (cents / 100).toFixed(2);
  return item;
}

/**
 * Save one annual activity with its quarterly activities and cost items, as the editor
 * holds them. Records sent with an id are updated, records without one are created, and
 * records of this activity that are no longer sent are removed. Returns the client keys
 * of new records with their ids.
 */
export async function saveActivity(user, id, { revision, activity }) {
  if (!activity || typeof activity !== "object") throw fail("No activity given");
  return sequelize.transaction(async (transaction) => {
    const plan = await openForEdit(user, id, revision, transaction);
    const output = await outputOf(plan, activity.outputId, transaction);
    const keyMap = {};
    const description = text(activity.description, 2000);
    const reason = activity.revisionReason === undefined ? undefined : text(activity.revisionReason, 4000);
    let row;
    if (activity.id) {
      row = await activityOf(plan, activity.id, transaction);
      if (row.output_id !== output.id) throw fail("The activity belongs to another Main Output");
      await row.update({ description, ...(reason !== undefined ? { revision_reason: reason || null } : {}), updated_by: user.name }, { transaction });
    } else {
      const sort = (await WorkPlanActivity.max("sort", { where: { output_id: output.id }, transaction })) ?? 0;
      row = await WorkPlanActivity.create({ output_id: output.id, description, revision_reason: reason || null, sort: sort + 1, created_by: user.name, updated_by: user.name }, { transaction });
      if (activity.key) keyMap[activity.key] = row.id;
    }

    // A record restored in the editor may carry the baseline record it came from (validated).
    const baselineIds = async (Model, ids) => {
      if (!ids.length || plan.stage !== "Revised" || !plan.parent_plan_id) return new Set();
      const found = await Model.findAll({ where: { id: ids }, transaction });
      const ok = new Set();
      for (const f of found) if (await inPlan({ id: plan.parent_plan_id }, Model === WorkPlanQuarterActivity ? "quarter" : "item", f.id, transaction).catch(() => null)) ok.add(f.id);
      return ok;
    };
    const quartersIn = Array.isArray(activity.quarters) ? activity.quarters : [];
    const okQOrigins = await baselineIds(WorkPlanQuarterActivity, quartersIn.filter((q) => !q.id && q.originId).map((q) => Number(q.originId)));
    const okIOrigins = await baselineIds(WorkPlanCostItem, quartersIn.flatMap((q) => (q.items ?? []).filter((i) => !i.id && i.originId).map((i) => Number(i.originId))));
    const existingQ = await WorkPlanQuarterActivity.findAll({ where: { activity_id: row.id }, include: [{ model: WorkPlanCostItem, as: "items" }], transaction });
    const qById = new Map(existingQ.map((q) => [q.id, q]));
    const keptQ = new Set();
    const quarters = Array.isArray(activity.quarters) ? activity.quarters : [];
    for (const [qi, q] of quarters.entries()) {
      const quarter = Number(q.quarter);
      if (![1, 2, 3, 4].includes(quarter)) throw fail("Quarter must be 1 to 4");
      const items = Array.isArray(q.items) ? q.items : [];
      const qValues = { quarter, description: text(q.description, 2000), no_cost: Boolean(q.noCost) && items.length === 0, sort: qi, updated_by: user.name };
      let qRow;
      if (q.id) {
        qRow = qById.get(Number(q.id));
        if (!qRow) throw fail("A quarterly activity does not belong to this activity", 400);
        await qRow.update(qValues, { transaction });
      } else {
        const origin = q.originId && okQOrigins.has(Number(q.originId)) ? Number(q.originId) : null;
        qRow = await WorkPlanQuarterActivity.create({ ...qValues, activity_id: row.id, origin_id: origin, created_by: user.name }, { transaction });
        if (origin) await WorkPlanDecision.destroy({ where: { work_plan_id: plan.id, record_type: "quarter", origin_id: origin }, transaction });
        if (q.key) keyMap[q.key] = qRow.id;
      }
      keptQ.add(qRow.id);
      const itemById = new Map((qRow.items ?? []).map((i) => [i.id, i]));
      const keptI = new Set();
      for (const [ii, raw] of items.entries()) {
        const values = { ...(await cleanItem(raw, plan.year)), sort: ii, updated_by: user.name };
        if (raw.revisionReason !== undefined) values.revision_reason = text(raw.revisionReason, 2000) || null;
        if (raw.id && itemById.has(Number(raw.id))) {
          await itemById.get(Number(raw.id)).update(values, { transaction });
          keptI.add(Number(raw.id));
        } else {
          if (raw.id) throw fail("A cost item does not belong to this quarterly activity", 400);
          const origin = raw.originId && okIOrigins.has(Number(raw.originId)) ? Number(raw.originId) : null;
          const created = await WorkPlanCostItem.create(
            { ...values, quarter_activity_id: qRow.id, origin_id: origin, copied_from_id: raw.copiedFromId ? Number(raw.copiedFromId) || null : null, created_by: user.name },
            { transaction },
          );
          keptI.add(created.id);
          if (raw.key) keyMap[raw.key] = created.id;
        }
      }
      const drop = [...itemById.keys()].filter((i) => !keptI.has(i));
      if (drop.length) await WorkPlanCostItem.destroy({ where: { id: drop }, transaction });
    }
    const dropQ = [...qById.keys()].filter((q) => !keptQ.has(q));
    if (dropQ.length) await WorkPlanQuarterActivity.destroy({ where: { id: dropQ }, transaction });

    // Explicit decisions on baseline records dropped in the editor (e.g. a deferred quarterly activity).
    if (plan.stage === "Revised" && Array.isArray(activity.decisions))
      for (const d of activity.decisions) await recordDecision(plan, d, user, transaction);
    // The justification is tied to the revised cost it was written for (reviewed when costs change).
    if (plan.stage === "Revised" && (activity.reasonConfirmed || (reason !== undefined && reason))) {
      const [[{ total }]] = await sequelize.query(
        "SELECT COALESCE(SUM(i.amount), 0) AS total FROM work_plan_cost_items i JOIN work_plan_quarter_activities q ON q.id = i.quarter_activity_id WHERE q.activity_id = ?",
        { replacements: [row.id], transaction },
      );
      await row.update({ reason_basis_cents: Math.round(Number(total || 0) * 100) }, { transaction });
    }

    await bump(plan, user, transaction);
    return { ...(await describe(plan, transaction)), activityId: row.id, keyMap };
  });
}

/** Revise one cost item from the consolidated Costing worksheet (same record as the editor). */
export async function patchCostItem(user, id, itemId, body) {
  return sequelize.transaction(async (transaction) => {
    const plan = await openForEdit(user, id, body.revision, transaction);
    const item = await WorkPlanCostItem.findByPk(itemId, {
      include: [{ model: WorkPlanQuarterActivity, as: "quarterActivity", include: [{ model: WorkPlanActivity, as: "activityRecord", include: [{ model: WorkPlanOutput, as: "outputRecord", where: { work_plan_id: plan.id } }] }] }],
      transaction,
    });
    if (!item?.quarterActivity?.activityRecord?.outputRecord) throw fail("Cost item not found in this work plan", 404);
    const merged = {
      naturalAccountId: item.natural_account_id,
      description: item.description,
      fundingSource: item.funding_source,
      unitOfMeasure: item.unit_of_measure,
      costingMethod: item.costing_method,
      quantity: item.quantity,
      unitCost: item.unit_cost,
      frequency: item.frequency,
    };
    for (const k of Object.keys(merged)) if (k in body) merged[k] = body[k];
    await item.update({ ...(await cleanItem(merged, plan.year)), ...("revisionReason" in body ? { revision_reason: text(body.revisionReason, 2000) || null } : {}), updated_by: user.name }, { transaction });
    await bump(plan, user, transaction);
    return describe(plan, transaction);
  });
}

/* ---------- workflow (same steps and rules as the Cash Plan) ---------- */

const STEPS = {
  submit: { from: ["Draft", "Returned"], to: "PendingReview", permission: "workPlan.submit", label: "submitted for review" },
  recommend: { from: ["PendingReview"], to: "PendingApproval", permission: "workPlan.review", label: "recommended for approval" },
  approve: { from: ["PendingApproval"], to: "SubmittedToPCMED", permission: "workPlan.approve", label: "approved and submitted to PCMED" },
  startVerification: { from: ["SubmittedToPCMED"], to: "UnderVerification", permission: "pcmed.review", label: "taken for verification" },
  verify: { from: ["UnderVerification"], to: "Verified", permission: "pcmed.approve", label: "verified" },
};
const RETURN_PERMISSION = { PendingReview: "workPlan.return", PendingApproval: "workPlan.return", SubmittedToPCMED: "pcmed.return", UnderVerification: "pcmed.return" };
const STAGE_ACTOR = { PendingReview: "workPlan.review", PendingApproval: "workPlan.approve", SubmittedToPCMED: "pcmed.review", UnderVerification: "pcmed.approve" };

async function assertPermission(user, permission) {
  if (!(await permissionsForRole(user.role))[permission]) throw fail("Your role cannot take this step", 403);
}
async function notifyNext(plan, user, permission, message, event) {
  try {
    await notifyPcmedStep({ record: plan, actorId: user.id, entityType: "workPlan", event, message, permission });
  } catch (error) {
    console.error("Work plan notification failed:", error);
  }
}
const total = (outputs) => outputs.reduce((s, o) => s + o.activities.reduce((s2, a) => s2 + a.quarters.reduce((s3, q) => s3 + q.items.reduce((s4, i) => s4 + i.amountCents, 0), 0), 0), 0);

export async function advancePlan(user, id, action, { comment, revision }) {
  const step = STEPS[action];
  if (!step) throw fail("Unknown action");
  await assertPermission(user, step.permission);
  return sequelize.transaction(async (transaction) => {
    const plan = await loadPlanForUser(user, id, transaction);
    const from = plan.status;
    if (!step.from.includes(from)) throw fail(`This work plan is ${STATUS_LABEL[from].toLowerCase()}; it cannot be ${step.label} now`, 409);
    // The submission is checked against exactly what the officer saw.
    if (action === "submit" && revision !== undefined && Number(revision) !== plan.revision)
      throw fail("This work plan changed since you opened it. Reload and check it before submitting.", 409, { code: "stale", revision: plan.revision });
    if (action === "recommend" && plan.submitted_by_id === user.id) throw fail("You submitted this work plan, so another officer must review it", 403);
    if (action === "approve" && [plan.submitted_by_id, plan.recommended_by_id].includes(user.id)) throw fail("You submitted or recommended this work plan, so another officer must approve it", 403);
    if (action === "verify" && plan.reviewed_by_id === user.id) throw fail("You took this work plan for verification, so another PCMED officer must verify it", 403);

    const state = await describe(plan, transaction);
    // A Revised Work Plan over its ceiling cannot move forward at any step.
    if (state.ceiling?.errors.length) throw fail("The work plan exceeds the approved ceiling", 400, { validation: state.validation });
    if (["submit", "recommend", "approve"].includes(action) && state.validation.errors.length)
      throw fail(`The work plan has ${state.validation.errors.length} issue${state.validation.errors.length === 1 ? "" : "s"} to resolve first`, 400, { validation: state.validation });

    const note = String(comment ?? "").trim() || null;
    const now = new Date();
    const changes = { status: step.to, revision: plan.revision + 1 };
    if (action === "submit")
      Object.assign(changes, {
        submission_remarks: note,
        submitted_by: user.name,
        submitted_by_id: user.id,
        submitted_at: now,
        return_reason: null,
        returned_stage: null,
        recommended_by: null,
        recommended_by_id: null,
        recommended_at: null,
        dad_approved_by: null,
        dad_approved_by_id: null,
        dad_approved_at: null,
        reviewed_by: null,
        reviewed_by_id: null,
        review_started_at: null,
      });
    if (action === "recommend") Object.assign(changes, { recommended_by: user.name, recommended_by_id: user.id, recommended_at: now, recommendation_comment: note });
    if (action === "approve") Object.assign(changes, { dad_approved_by: user.name, dad_approved_by_id: user.id, dad_approved_at: now });
    if (action === "startVerification") Object.assign(changes, { reviewed_by: user.name, reviewed_by_id: user.id, review_started_at: now });
    if (action === "verify") Object.assign(changes, { approved_by: user.name, approved_by_id: user.id, approved_at: now, approval_comment: note });
    await plan.update(changes, { transaction });
    if (action === "submit") await WorkPlanObservation.update({ resolved_at: now }, { where: { work_plan_id: plan.id, resolved_at: null }, transaction });
    if (action === "submit")
      await WorkPlanVersion.create(
        { work_plan_id: plan.id, revision: plan.revision, status: plan.status, total: (total(state.outputs) / 100).toFixed(2), snapshot: state.outputs, created_by: user.name, created_by_id: user.id },
        { transaction },
      );
    return { plan, from, note, state };
  }).then(async ({ plan, from, note }) => {
    await logWorkflowEvent({ entityType: "workPlan", record: plan, action, from, to: plan.status, comment: note, user });
    const where = `${plan.organization} FY ${plan.year}`;
    if (action === "submit") await notifyNext(plan, user, "workPlan.review", `${user.name} submitted the ${where} work plan for review`, from === "Returned" ? "resubmitted" : "created");
    if (action === "recommend") await notifyNext(plan, user, "workPlan.approve", `${user.name} recommended the ${where} work plan for approval`, "reviewed");
    if (action === "approve") await notifyNext(plan, user, "pcmed.review", `${user.name} approved the ${where} work plan and submitted it to PCMED`, "sent_to_pcmed");
    if (action === "startVerification") await notifyNext(plan, user, "pcmed.approve", `${user.name} took the ${where} work plan for verification`, "pcmed_reviewed");
    if (action === "verify") await notifyNext(plan, user, "workPlan.submit", `PCMED verified the ${where} work plan`, "pcmed_approved");
    return describe(plan);
  });
}

export async function returnPlan(user, id, { comment }) {
  const plan = await loadPlanForUser(user, id);
  const from = plan.status;
  const permission = RETURN_PERMISSION[from];
  if (!permission) throw fail(`A work plan that is ${STATUS_LABEL[from].toLowerCase()} cannot be returned`, 409);
  await assertPermission(user, permission);
  await assertPermission(user, STAGE_ACTOR[from]);
  const note = String(comment ?? "").trim();
  if (!note) throw fail("Give the reason for returning the work plan");
  await plan.update({ status: "Returned", return_reason: note, returned_by: user.name, returned_at: new Date(), returned_stage: from, revision: plan.revision + 1 });
  await logWorkflowEvent({ entityType: "workPlan", record: plan, action: "return", from, to: "Returned", comment: note, user });
  await notifyNext(plan, user, "workPlan.submit", `${user.name} returned the ${plan.organization} FY ${plan.year} work plan for correction: ${note}`, from.startsWith("Pending") ? "returned" : "pcmed_returned");
  return describe(plan);
}

/** Work Plans (Initial or Revised) waiting for PCMED, within the user's data scope. */
export async function awaitingPcmed(user) {
  const perms = await permissionsForRole(user.role);
  if (!perms["pcmed.review"] && !perms["pcmed.approve"]) return [];
  const scope = await dadScope(user);
  const rows = await WorkPlan.findAll({ where: { status: ["SubmittedToPCMED", "UnderVerification"] }, order: [["updated_at", "ASC"]] });
  return rows.filter((p) => inScope(scope, p.organization)).map(planDto);
}

export async function planHistory(user, id) {
  const plan = await loadPlanForUser(user, id);
  const versions = await WorkPlanVersion.findAll({ where: { work_plan_id: plan.id }, attributes: ["id", "revision", "status", "total", "created_by", "created_at"], order: [["id", "ASC"]] });
  return {
    events: await workflowHistory("workPlan", plan.id),
    versions: versions.map((v) => ({ id: v.id, revision: v.revision, status: v.status, totalCents: toCents(v.total), by: v.created_by, at: v.created_at })),
  };
}

/* ---------- central registers (System Management) ---------- */

const REGISTERS = {
  accounts: {
    model: NaturalAccount,
    clean: (b) => {
      const code = text(b.code, 20);
      if (!/^\d+$/.test(code)) throw fail("The account code must contain digits only (leading zeros are kept)");
      const description = text(b.description, 255);
      if (!description) throw fail("Enter the account description");
      const ec = text(b.economicClassification, 60);
      if (!["Compensation of Employees", "Goods and Services", "Capital Expenditure"].includes(ec)) throw fail("Choose the economic classification");
      return { code, description, economic_classification: ec, is_posting: b.isPosting !== false };
    },
    dto: (a) => ({ id: a.id, code: a.code, description: a.description, economicClassification: a.economic_classification, isPosting: a.is_posting }),
    order: [["code", "ASC"]],
    inUse: async (id) => WorkPlanCostItem.count({ where: { natural_account_id: id } }),
    noun: "natural account",
  },
  objectives: {
    model: StrategicObjective,
    clean: (b) => {
      const code = text(b.code, 30);
      if (!code) throw fail("Enter the objective code");
      const objective = text(b.objective, 500);
      if (!objective) throw fail("Enter the objective");
      return { code, objective };
    },
    dto: (o) => ({ id: o.id, code: o.code, objective: o.objective }),
    order: [["code", "ASC"]],
    inUse: async (id) => WorkPlanOutput.count({ where: { objective_id: id } }),
    noun: "objective",
  },
};
const yearOf = (v, label) => {
  if (v === null || v === undefined || v === "") return null;
  const y = Number(v);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw fail(`${label} must be a year`);
  return y;
};
const commonDto = (r) => ({ validFromYear: r.valid_from_year, validToYear: r.valid_to_year, status: r.status, updatedBy: r.updated_by ?? r.created_by, updatedAt: r.updated_at });

export async function listRegister(kind) {
  const R = REGISTERS[kind];
  const rows = await R.model.findAll({ order: R.order });
  return Promise.all(rows.map(async (r) => ({ ...R.dto(r), ...commonDto(r), inUse: await R.inUse(r.id) })));
}

export async function saveRegister(kind, user, id, body) {
  const R = REGISTERS[kind];
  const values = { ...R.clean(body), valid_from_year: yearOf(body.validFromYear, "Valid from"), valid_to_year: yearOf(body.validToYear, "Valid to"), updated_by: user.name };
  if (values.valid_from_year && values.valid_to_year && values.valid_to_year < values.valid_from_year) throw fail("“Valid to” cannot be before “Valid from”");
  if (body.status) values.status = body.status === "inactive" ? "inactive" : "active";
  const clash = await R.model.findOne({ where: { code: values.code, ...(id ? { id: { [Op.ne]: id } } : {}) } });
  if (clash) throw fail(`Another ${R.noun} already uses code ${values.code}`, 409);
  if (id) {
    const row = await R.model.findByPk(id);
    if (!row) throw fail(`${R.noun} not found`, 404);
    if (row.code !== values.code && (await R.inUse(id))) throw fail(`This ${R.noun} is used in work plans, so its code cannot change. Deactivate it and add a new one.`, 409);
    await row.update(values);
    return R.dto(row);
  }
  return R.dto(await R.model.create({ ...values, created_by: user.name }));
}

export async function deleteRegister(kind, id) {
  const R = REGISTERS[kind];
  const row = await R.model.findByPk(id);
  if (!row) throw fail(`${R.noun} not found`, 404);
  if (await R.inUse(id)) throw fail(`This ${R.noun} is used in work plans. Deactivate it instead.`, 409);
  await row.destroy();
}

/* ---------- Revised Work Plan: decisions, restoration, comparison, observations ---------- */

const MODELS = { output: WorkPlanOutput, activity: WorkPlanActivity, quarter: WorkPlanQuarterActivity, item: WorkPlanCostItem };

/** Record that a baseline record was removed or deferred (with the reason). */
async function recordDecision(plan, d, user, transaction) {
  if (!MODELS[d.type] || !d.originId || !["removed", "deferred"].includes(d.decision)) throw fail("Invalid revision decision");
  const values = { decision: d.decision, reason: text(d.reason, 2000) || null, created_by: user.name, created_by_id: user.id };
  const [row, created] = await WorkPlanDecision.findOrCreate({ where: { work_plan_id: plan.id, record_type: d.type, origin_id: Number(d.originId) }, defaults: values, transaction });
  if (!created) await row.update(values, { transaction });
}

async function inPlan(plan, type, id, transaction) {
  const include = {
    output: [],
    activity: [{ model: WorkPlanOutput, as: "outputRecord", where: { work_plan_id: plan.id } }],
    quarter: [{ model: WorkPlanActivity, as: "activityRecord", include: [{ model: WorkPlanOutput, as: "outputRecord", where: { work_plan_id: plan.id } }] }],
    item: [{ model: WorkPlanQuarterActivity, as: "quarterActivity", include: [{ model: WorkPlanActivity, as: "activityRecord", include: [{ model: WorkPlanOutput, as: "outputRecord", where: { work_plan_id: plan.id } }] }] }],
  }[type];
  const row = await MODELS[type].findByPk(id, { include, transaction });
  const ok = type === "output" ? row?.work_plan_id === plan.id : type === "activity" ? row?.outputRecord : type === "quarter" ? row?.activityRecord?.outputRecord : row?.quarterActivity?.activityRecord?.outputRecord;
  if (!ok) throw fail("Record not found in this work plan", 404);
  return row;
}

/** Remove or defer a record of the Revised Work Plan. Baseline records keep a decision with the reason. */
export async function decideRecord(user, id, { revision, type, recordId, decision, reason }) {
  return sequelize.transaction(async (transaction) => {
    const plan = await openForEdit(user, id, revision, transaction);
    if (!["output", "activity", "quarter"].includes(type)) throw fail("Choose an output, activity or quarterly activity");
    if (!["removed", "deferred"].includes(decision)) throw fail("Choose remove or defer");
    const row = await inPlan(plan, type, recordId, transaction);
    if (plan.stage === "Revised" && row.origin_id) {
      if (!String(reason ?? "").trim()) throw fail(`Give the reason for ${decision === "deferred" ? "deferring" : "removing"} it`);
      await recordDecision(plan, { type, originId: row.origin_id, decision, reason }, user, transaction);
    }
    await row.destroy({ transaction });
    await bump(plan, user, transaction);
    return describe(plan, transaction);
  });
}

const copyValues = {
  output: (b) => ({ objective_id: b.objective_id, output: b.output, means_of_verification: b.means_of_verification, sort: b.sort }),
  activity: (b) => ({ description: b.description, sort: b.sort }),
  quarter: (b) => ({ quarter: b.quarter, description: b.description, no_cost: b.no_cost, sort: b.sort }),
  item: (b) => ({
    natural_account_id: b.natural_account_id,
    description: b.description,
    funding_source: b.funding_source,
    unit_of_measure: b.unit_of_measure,
    costing_method: b.costing_method,
    quantity: b.quantity,
    unit_cost: b.unit_cost,
    frequency: b.frequency,
    amount: b.amount,
    sort: b.sort,
  }),
};
const PARENT = { activity: ["output", "output_id"], quarter: ["activity", "activity_id"], item: ["quarter", "quarter_activity_id"] };
const CHILDREN = { output: ["activity", "output_id"], activity: ["quarter", "activity_id"], quarter: ["item", "quarter_activity_id"] };

/**
 * Restore a baseline record into the Revised Work Plan: a record still present gets its
 * original values back (its children are untouched); a removed or deferred record is copied
 * back with its children. Missing parents are restored first. Revalidated like any edit.
 */
export async function restoreRecord(user, id, { revision, type, originId }) {
  return sequelize.transaction(async (transaction) => {
    const plan = await openForEdit(user, id, revision, transaction);
    if (plan.stage !== "Revised" || !plan.parent_plan_id) throw fail("Only a Revised Work Plan has original records to restore");
    if (!MODELS[type]) throw fail("Unknown record type");
    const base = await inPlan({ id: plan.parent_plan_id }, type, originId, transaction);
    const ensure = async (t, baseRow, deep) => {
      const where = { origin_id: baseRow.id };
      if (t === "output") where.work_plan_id = plan.id;
      let existing = await MODELS[t].findOne({ where, transaction });
      if (t !== "output" && existing) existing = await inPlan(plan, t, existing.id, transaction).catch(() => null);
      if (existing) {
        if (deep === "values") await existing.update({ ...copyValues[t](baseRow), updated_by: user.name }, { transaction });
        return existing;
      }
      let parentField = {};
      if (PARENT[t]) {
        const [pt, fk] = PARENT[t];
        const baseParent = await MODELS[pt].findByPk(baseRow[fk], { transaction });
        const parent = await ensure(pt, baseParent, "shell");
        parentField = { [fk]: parent.id };
      } else parentField = { work_plan_id: plan.id };
      const created = await MODELS[t].create({ ...copyValues[t](baseRow), ...parentField, origin_id: baseRow.id, created_by: user.name, updated_by: user.name }, { transaction });
      await WorkPlanDecision.destroy({ where: { work_plan_id: plan.id, record_type: t, origin_id: baseRow.id }, transaction });
      if (deep !== "shell" && CHILDREN[t]) {
        const [ct, fk] = CHILDREN[t];
        for (const child of await MODELS[ct].findAll({ where: { [fk]: baseRow.id }, transaction })) await ensure(ct, child, "deep");
      }
      return created;
    };
    await ensure(type, base, "values");
    await bump(plan, user, transaction);
    return describe(plan, transaction);
  });
}

/** Compare two versions: "initial", "current" or "version:<id>" (a submitted snapshot of this plan). */
export async function compareVersions(user, id, { base = "initial", target = "current" }) {
  const plan = await loadPlanForUser(user, id);
  const regs = await registers(plan.year);
  const pick = async (which) => {
    if (which === "current") return { kind: plan.stage === "Revised" ? "revised" : "initial", outputs: await loadTree(plan.id), label: plan.stage === "Revised" ? "Active Revised Work Plan" : "Work Plan" };
    if (which === "initial") {
      if (plan.stage !== "Revised") return { kind: "initial", outputs: await loadTree(plan.id), label: "Initial Work Plan" };
      return { kind: "initial", outputs: plan.parent_plan_id ? await loadTree(plan.parent_plan_id) : [], label: "Initial Work Plan" };
    }
    const vid = Number(String(which).replace("version:", ""));
    const v = await WorkPlanVersion.findOne({ where: { id: vid, work_plan_id: plan.id } });
    if (!v) throw fail("Version not found", 404);
    return { kind: plan.stage === "Revised" ? "revised" : "initial", outputs: v.snapshot, label: `Submitted ${new Date(v.created_at).toLocaleString("en-GB")}` };
  };
  const [b, t] = await Promise.all([pick(base), pick(target)]);
  const result = compareTrees(b, t, { accounts: regs.accounts, decisions: await decisionMap(plan.id) });
  return { baseLabel: b.label, targetLabel: t.label, ...result };
}

const REVIEW_STAGE = { PendingReview: "workPlan.review", PendingApproval: "workPlan.approve", SubmittedToPCMED: "pcmed.review", UnderVerification: "pcmed.approve" };

/** A reviewer's observation on the plan or one of its records (reviewers never change the figures). */
export async function addObservation(user, id, { recordType = "plan", recordId, recordLabel, text: body }) {
  const plan = await loadPlanForUser(user, id);
  const permission = REVIEW_STAGE[plan.status];
  if (!permission || !(await permissionsForRole(user.role))[permission]) throw fail("Observations are made by the officer reviewing the current stage", 403);
  const note = text(body, 2000);
  if (!note) throw fail("Write the observation");
  if (recordType !== "plan") await inPlan(plan, recordType, recordId);
  await WorkPlanObservation.create({ work_plan_id: plan.id, record_type: recordType, record_id: recordType === "plan" ? null : Number(recordId), record_label: String(recordLabel ?? "").slice(0, 300) || null, stage: plan.status, text: note, created_by: user.name, created_by_id: user.id, created_by_role: user.role });
  return describe(plan);
}

/** Verified Work Plan records for the next planning modules (Results Framework, Budget Preparation). */
export async function verifiedRecords(user, { year, organization: requested }) {
  const organization = resolveOrganization(user, requested);
  await assertScope(user, organization);
  const plan = await WorkPlan.findOne({ where: { organization, year: Number(year), status: "Verified" }, order: [["stage", "DESC"]] });
  if (!plan) return { plan: null, outputs: [] };
  return { plan: planDto(plan), outputs: await loadTree(plan.id) };
}

export async function planForExport(user, id) {
  const plan = await loadPlanForUser(user, id);
  return { ...(await describe(plan)), history: await workflowHistory("workPlan", plan.id), accounts: (await registers(plan.year)).accounts };
}
