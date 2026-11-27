// Annual Cash Plan: one plan per DAD and year, prepared per activity.
//
// Plan lines come from the DAD's budget lines for the year (loadeddata), grouped by
// Activity/Operation × economic classification × funding source; several natural
// accounts of the same activity add up to one line. The line's budget allocation is
// always read live from those budget lines; only monthly amounts are stored.
import crypto from "crypto";
import { Op } from "sequelize";
import sequelize from "../config/database.js";
import LoadedData from "../models/loadedData.js";
import { CashPlan, CashPlanAllocation, CashPlanLine, CashPlanLineBudget, CashPlanVersion } from "../models/cashPlan.model.js";
import { notifyPcmedStep } from "../utils/notify.js";
import { inScope, dadScope, seesAllDads } from "../utils/dataScope.js";
import { logWorkflowEvent, workflowHistory } from "../utils/workflowLog.js";
import { permissionsForRole } from "../utils/permissions.js";

export const ECONOMIC_CLASSES = ["Compensation of Employees", "Goods and Services", "Capital Expenditure"];
const EDITABLE = new Set(["Draft", "Returned"]);
const MAX_AMOUNT_CENTS = 1e15; // DECIMAL(15,2)

const fail = (message, statusCode = 400, extra = {}) => Object.assign(new Error(message), { statusCode, ...extra });
const toCents = (v) => Math.round(Number(v || 0) * 100);
const fromCents = (c) => Number((c / 100).toFixed(2));

/** Identity of a plan line: activity (code, else name) × classification × funding source. */
function lineKey({ activityCode, activity, economicClassification, sourceOfFunding }) {
  const act = activityCode ? `code:${activityCode.trim().toUpperCase()}` : activity ? `name:${activity.trim().toLowerCase()}` : "unassigned";
  return crypto.createHash("sha1").update(`${act}|${economicClassification}|${sourceOfFunding}`).digest("hex");
}

/** Budget lines for a DAD and year, grouped into plan lines. */
async function budgetGroups(year, organization, transaction) {
  const rows = await LoadedData.findAll({ where: { year, organization }, transaction, order: [["id", "ASC"]] });
  const groups = new Map();
  for (const r of rows) {
    const key = lineKey(r);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        activityCode: r.activityCode || null,
        activity: r.activity || null,
        economicClassification: r.economicClassification,
        sourceOfFunding: r.sourceOfFunding,
        policyClassification: r.policyClassification || "Normal",
        budgetCents: 0,
        budgetLineIds: [],
        naturalAccounts: [],
      });
    }
    const g = groups.get(key);
    g.budgetCents += toCents(r.appropriation);
    g.budgetLineIds.push(r.id);
    g.naturalAccounts.push(r.naturalAccount);
    if (r.policyClassification === "KPI") g.policyClassification = "KPI";
    if (!g.activity && r.activity) g.activity = r.activity;
  }
  return groups;
}

/** Organisation whose plan the user may open (DAD users: always their own). */
export function resolveOrganization(user, requested) {
  if (seesAllDads(user) || user.data_scope === "assigned") {
    if (!requested) throw fail("Choose a DAD");
    return requested;
  }
  if (!user.organization) throw fail("Your account is not assigned to a DAD", 403);
  return user.organization;
}

async function assertScope(user, organization) {
  if (!inScope(await dadScope(user), organization)) throw fail("This cash plan belongs to a DAD outside your data scope", 403);
}

/** Bring an editable plan's lines in line with the current budget (adds lines and budget links; never deletes amounts). */
async function syncLines(plan, groups, transaction) {
  const lines = await CashPlanLine.findAll({ where: { cash_plan_id: plan.id }, include: [{ model: CashPlanLineBudget, as: "budgetLinks" }], transaction });
  const byKey = new Map(lines.map((l) => [l.line_key, l]));
  for (const g of groups.values()) {
    let line = byKey.get(g.key);
    if (!line) {
      line = await CashPlanLine.create(
        {
          cash_plan_id: plan.id,
          line_key: g.key,
          activity_code: g.activityCode,
          activity: g.activity,
          economic_classification: g.economicClassification,
          source_of_funding: g.sourceOfFunding,
          policy_classification: g.policyClassification,
        },
        { transaction },
      );
      line.budgetLinks = [];
    } else if (line.activity !== g.activity || line.policy_classification !== g.policyClassification) {
      await line.update({ activity: g.activity, policy_classification: g.policyClassification }, { transaction });
    }
    const linked = new Set(line.budgetLinks.map((b) => b.loaded_data_id));
    const wanted = new Set(g.budgetLineIds);
    const add = g.budgetLineIds.filter((id) => !linked.has(id));
    const remove = line.budgetLinks.filter((b) => !wanted.has(b.loaded_data_id)).map((b) => b.id);
    if (add.length) await CashPlanLineBudget.bulkCreate(add.map((id) => ({ cash_plan_line_id: line.id, loaded_data_id: id })), { transaction });
    if (remove.length) await CashPlanLineBudget.destroy({ where: { id: remove }, transaction });
  }
}

/** The plan as the workspace shows it: header, lines with live budget and monthly amounts, and validation. */
async function describe(plan, groups) {
  const lines = await CashPlanLine.findAll({
    where: { cash_plan_id: plan.id },
    include: [{ model: CashPlanAllocation, as: "allocations" }],
    order: [["id", "ASC"]],
  });
  const out = lines.map((l) => {
    const g = groups.get(l.line_key);
    const months = Array(12).fill(0);
    l.allocations.forEach((a) => {
      if (a.month >= 1 && a.month <= 12) months[a.month - 1] = toCents(a.amount);
    });
    return {
      id: l.id,
      activityCode: l.activity_code,
      activity: l.activity,
      economicClassification: l.economic_classification,
      sourceOfFunding: l.source_of_funding,
      policyClassification: l.policy_classification,
      justification: l.justification ?? "",
      inBudget: Boolean(g),
      budgetLineIds: g?.budgetLineIds ?? [],
      naturalAccounts: g?.naturalAccounts ?? [],
      budgetCents: g?.budgetCents ?? 0,
      monthsCents: months,
    };
  });
  // A line whose budget lines were remapped to another activity drops out once it holds no amounts.
  const shown = out.filter((l) => l.inBudget || l.monthsCents.some((c) => c > 0));
  return {
    plan: {
      id: plan.id,
      year: plan.year,
      organization: plan.organization,
      version: plan.version,
      status: plan.status,
      revision: plan.revision,
      updatedAt: plan.updated_at,
      updatedBy: plan.updated_by,
      createdAt: plan.created_at,
      submittedAt: plan.submitted_at,
      submittedBy: plan.submitted_by,
      submissionRemarks: plan.submission_remarks,
      returnReason: plan.return_reason,
      returnedBy: plan.returned_by,
      returnedAt: plan.returned_at,
      approvedAt: plan.approved_at,
      approvedBy: plan.approved_by,
      submittedById: plan.submitted_by_id,
      recommendedBy: plan.recommended_by,
      recommendedById: plan.recommended_by_id,
      recommendedAt: plan.recommended_at,
      dadApprovedBy: plan.dad_approved_by,
      dadApprovedAt: plan.dad_approved_at,
      reviewedBy: plan.reviewed_by,
      reviewedById: plan.reviewed_by_id,
      returnedStage: plan.returned_stage,
    },
    lines: shown,
    validation: validateLines(shown),
  };
}

/** Line status from cents: notStarted | partial | full | over. */
export function lineStatus(budgetCents, totalCents) {
  if (totalCents === 0 && budgetCents > 0) return "notStarted";
  if (totalCents > budgetCents) return "over";
  if (totalCents === budgetCents) return "full";
  return totalCents === 0 ? "notStarted" : "partial";
}

/** Blocking errors and warnings for the whole plan (every line, whatever the filters). */
export function validateLines(lines) {
  const errors = [];
  const warnings = [];
  const seen = new Set();
  for (const l of lines) {
    const name = l.activity || l.activityCode || "Activity not assigned";
    const label = `${name} (${l.economicClassification}, ${l.sourceOfFunding})`;
    const total = l.monthsCents.reduce((a, b) => a + b, 0);
    const status = lineStatus(l.budgetCents, total);
    const key = `${l.activityCode || l.activity || ""}|${l.economicClassification}|${l.sourceOfFunding}`;
    if (seen.has(key)) errors.push({ lineId: l.id, code: "duplicate", message: `${label} appears more than once` });
    seen.add(key);
    if (l.monthsCents.some((c) => c < 0)) errors.push({ lineId: l.id, code: "negative", message: `${label} has a negative monthly amount` });
    if (!l.inBudget) {
      if (total > 0) errors.push({ lineId: l.id, code: "notInBudget", message: `${label} is no longer in the approved budget but has planned cash` });
      continue;
    }
    if (!ECONOMIC_CLASSES.includes(l.economicClassification))
      errors.push({ lineId: l.id, code: "classification", message: `${label}: unknown economic classification` });
    if (!l.sourceOfFunding) errors.push({ lineId: l.id, code: "fund", message: `${label}: funding source missing` });
    if (status === "over")
      errors.push({ lineId: l.id, code: "over", message: `${label} is over-allocated by GH₵ ${fromCents(total - l.budgetCents).toLocaleString("en-GH", { minimumFractionDigits: 2 })}` });
    // Every activity must be fully allocated: its monthly total must equal the approved budget.
    if ((status === "partial" || status === "notStarted") && l.budgetCents > 0) {
      const gh = (c) => fromCents(c).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      errors.push({
        lineId: l.id,
        code: "under",
        message: `${label} is under-allocated by GH₵ ${gh(l.budgetCents - total)} (GH₵ ${gh(total)} of GH₵ ${gh(l.budgetCents)} planned)`,
      });
    }
    if (!l.activityCode && !l.activity)
      warnings.push({ lineId: l.id, code: "noActivity", message: `${l.economicClassification}, ${l.sourceOfFunding}: budget lines have no activity assigned` });
    else if (!l.activityCode) warnings.push({ lineId: l.id, code: "noCode", message: `${label} has no Activity/Operation code` });
  }
  return { errors, warnings };
}

/** Open (creating when needed) the latest plan for a DAD and year. */
export async function getPlan(user, { year, organization: requested, peek }) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw fail("Choose a valid financial year");
  const organization = resolveOrganization(user, requested);
  await assertScope(user, organization);

  const years = (
    await LoadedData.findAll({ where: { organization }, attributes: [[sequelize.fn("DISTINCT", sequelize.col("year")), "year"]], raw: true })
  )
    .map((r) => Number(r.year))
    .sort((a, b) => b - a);

  const groups = await budgetGroups(y, organization);
  let plan = await CashPlan.findOne({ where: { year: y, organization }, order: [["version", "DESC"]] });
  if (!plan && groups.size === 0) return { plan: null, lines: [], years, organization, validation: { errors: [], warnings: [] } };
  // peek: read an existing plan without creating or updating anything (e.g. copy previous year).
  if (peek) {
    if (!plan) return { plan: null, lines: [], years, organization, validation: { errors: [], warnings: [] } };
    return { ...(await describe(plan, groups)), years, organization };
  }

  // Users who cannot prepare cash plans (PCMED) see the budget lines of a DAD that has
  // not started its plan, without a plan being created on their behalf.
  if (!plan && !(await permissionsForRole(user.role))["cashPlan.edit"]) {
    const lines = [...groups.values()].map((g) => ({
      id: `budget:${g.key}`,
      activityCode: g.activityCode,
      activity: g.activity,
      economicClassification: g.economicClassification,
      sourceOfFunding: g.sourceOfFunding,
      policyClassification: g.policyClassification,
      justification: "",
      inBudget: true,
      budgetLineIds: g.budgetLineIds,
      naturalAccounts: g.naturalAccounts,
      budgetCents: g.budgetCents,
      monthsCents: Array(12).fill(0),
    }));
    return { plan: null, notStarted: true, lines, years, organization, validation: { errors: [], warnings: [] } };
  }

  await sequelize.transaction(async (transaction) => {
    if (!plan) {
      plan = await CashPlan.create(
        { year: y, organization, status: "Draft", created_by_id: user.id, created_by: user.name, updated_by_id: user.id, updated_by: user.name },
        { transaction },
      );
      await logWorkflowEvent({ entityType: "cashPlan", record: plan, action: "created", from: null, to: "Draft", user });
    }
    if (EDITABLE.has(plan.status)) await syncLines(plan, groups, transaction);
  });
  return { ...(await describe(plan, groups)), years, organization };
}

async function loadPlanForUser(user, id, transaction) {
  const plan = await CashPlan.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!plan) throw fail("Cash plan not found", 404);
  await assertScope(user, plan.organization);
  return plan;
}

/** Save monthly amounts: [{ lineId, month (1–12), amount }]. Refused when `revision` is stale. */
export async function saveAllocations(user, id, { revision, changes }) {
  if (!Array.isArray(changes) || changes.length === 0) throw fail("No changes to save");
  if (changes.length > 5000) throw fail("Too many changes in one save");
  return sequelize.transaction(async (transaction) => {
    const plan = await loadPlanForUser(user, id, transaction);
    if (!EDITABLE.has(plan.status)) throw fail(`This cash plan is ${(STATUS_LABEL[plan.status] ?? plan.status).toLowerCase()} and cannot be changed`, 409);
    if (Number(revision) !== plan.revision)
      throw fail("This cash plan was changed in another session. Reload to see the latest figures.", 409, { code: "stale", revision: plan.revision });

    const lineIds = new Set(
      (await CashPlanLine.findAll({ where: { cash_plan_id: plan.id }, attributes: ["id"], transaction })).map((l) => l.id),
    );
    const latest = new Map();
    for (const c of changes) {
      const lineId = Number(c.lineId);
      const month = Number(c.month);
      const amount = Number(c.amount);
      if (!lineIds.has(lineId)) throw fail("A changed line does not belong to this cash plan");
      if (!Number.isInteger(month) || month < 1 || month > 12) throw fail("Month must be 1 to 12");
      if (!Number.isFinite(amount) || amount < 0) throw fail("Amounts must be zero or more");
      const cents = Math.round(amount * 100);
      if (Math.abs(amount * 100 - cents) > 1e-6) throw fail("Amounts can have at most two decimal places");
      if (cents >= MAX_AMOUNT_CENTS) throw fail("Amount is too large");
      latest.set(`${lineId}:${month}`, { lineId, month, cents });
    }
    // Internal check: a line's monthly total may not exceed its approved budget.
    const changedLines = [...new Set([...latest.values()].map((c) => c.lineId))];
    const groups = await budgetGroups(plan.year, plan.organization, transaction);
    const planLines = await CashPlanLine.findAll({
      where: { id: changedLines },
      include: [{ model: CashPlanAllocation, as: "allocations" }],
      transaction,
    });
    for (const line of planLines) {
      const months = Array(12).fill(0);
      line.allocations.forEach((a) => (months[a.month - 1] = toCents(a.amount)));
      for (const c of latest.values()) if (c.lineId === line.id) months[c.month - 1] = c.cents;
      const total = months.reduce((a, b) => a + b, 0);
      const budget = groups.get(line.line_key)?.budgetCents ?? 0;
      if (total > budget) {
        const name = line.activity || line.activity_code || "Activity not assigned";
        const gh = (c) => fromCents(c).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        throw fail(`${name} (${line.economic_classification}, ${line.source_of_funding}): the monthly total of GH₵ ${gh(total)} would exceed the approved budget of GH₵ ${gh(budget)}`);
      }
    }

    for (const { lineId, month, cents } of latest.values()) {
      if (cents === 0) await CashPlanAllocation.destroy({ where: { cash_plan_line_id: lineId, month }, transaction });
      else {
        const [row, created] = await CashPlanAllocation.findOrCreate({
          where: { cash_plan_line_id: lineId, month },
          defaults: { amount: fromCents(cents) },
          transaction,
        });
        if (!created) await row.update({ amount: fromCents(cents) }, { transaction });
      }
    }
    plan.revision += 1;
    plan.updated_by_id = user.id;
    plan.updated_by = user.name;
    plan.changed("updated_at", true);
    await plan.save({ transaction });
    return { revision: plan.revision, updatedAt: plan.updated_at, updatedBy: plan.updated_by, saved: latest.size };
  });
}

/** Reason a line is not fully allocated. */
export async function saveJustification(user, id, lineId, text) {
  const plan = await loadPlanForUser(user, id);
  if (!EDITABLE.has(plan.status)) throw fail("This cash plan cannot be changed now", 409);
  const line = await CashPlanLine.findOne({ where: { id: lineId, cash_plan_id: plan.id } });
  if (!line) throw fail("Line not found", 404);
  const value = String(text ?? "").trim().slice(0, 2000);
  await line.update({ justification: value || null });
  return { lineId: line.id, justification: line.justification ?? "" };
}

async function currentState(plan) {
  return describe(plan, await budgetGroups(plan.year, plan.organization));
}

/* ---------- workflow ----------
   Draft/Returned --submit (Data Entry)--> PendingReview --recommend (DAD Reviewer)-->
   PendingApproval --approve (DAD Approver)--> SubmittedToPCMED --startVerification
   (PCMED)--> UnderVerification --verify (PCMED)--> Verified.
   "return" sends the plan back for correction from any of the four reviewing steps, with
   remarks; the corrected plan then goes through the internal review again. */
const STEPS = {
  submit: { from: ["Draft", "Returned"], to: "PendingReview", permission: "cashPlan.submit", label: "submitted for review" },
  recommend: { from: ["PendingReview"], to: "PendingApproval", permission: "cashPlan.review", label: "recommended for approval" },
  approve: { from: ["PendingApproval"], to: "SubmittedToPCMED", permission: "cashPlan.approve", label: "approved and submitted to PCMED" },
  startVerification: { from: ["SubmittedToPCMED"], to: "UnderVerification", permission: "pcmed.review", label: "taken for verification" },
  verify: { from: ["UnderVerification"], to: "Verified", permission: "pcmed.approve", label: "verified" },
};
// Who may return the plan at each step.
const RETURN_PERMISSION = { PendingReview: "cashPlan.return", PendingApproval: "cashPlan.return", SubmittedToPCMED: "pcmed.return", UnderVerification: "pcmed.return" };
const STATUS_LABEL = {
  Draft: "Draft",
  PendingReview: "Pending Review",
  PendingApproval: "Pending Approval",
  SubmittedToPCMED: "Submitted to PCMED",
  UnderVerification: "Under Verification",
  Returned: "Returned for Correction",
  Verified: "Verified",
};

async function assertPermission(user, permission) {
  if (!(await permissionsForRole(user.role))[permission]) throw fail("Your role cannot take this step", 403);
}

async function snapshot(plan, state, user) {
  await CashPlanVersion.create({
    cash_plan_id: plan.id,
    revision: plan.revision,
    status: plan.status,
    snapshot: state.lines.map((l) => ({
      lineId: l.id,
      activityCode: l.activityCode,
      activity: l.activity,
      economicClassification: l.economicClassification,
      sourceOfFunding: l.sourceOfFunding,
      budgetCents: l.budgetCents,
      monthsCents: l.monthsCents,
    })),
    created_by_id: user.id,
    created_by: user.name,
  });
}

async function notifyNext(plan, user, permission, message, event) {
  try {
    await notifyPcmedStep({ record: plan, actorId: user.id, entityType: "cashPlan", event, message, permission });
  } catch (error) {
    console.error("Cash plan notification failed:", error);
  }
}

/** Move the plan one step along the workflow (see STEPS). */
export async function advancePlan(user, id, action, { comment, remarks }) {
  const step = STEPS[action];
  if (!step) throw fail("Unknown action");
  await assertPermission(user, step.permission);
  const plan = await loadPlanForUser(user, id);
  const from = plan.status;
  if (!step.from.includes(from)) throw fail(`This cash plan is ${STATUS_LABEL[from].toLowerCase()}; it cannot be ${step.label} now`, 409);
  const note = String(comment ?? remarks ?? "").trim() || null;

  // Segregation of duties: nobody reviews or approves a plan they submitted or recommended,
  // and the PCMED officer who verifies is not the one who took it for verification.
  if (action === "recommend" && plan.submitted_by_id === user.id) throw fail("You submitted this cash plan, so another officer must review it", 403);
  if (action === "approve" && [plan.submitted_by_id, plan.recommended_by_id].includes(user.id))
    throw fail("You submitted or recommended this cash plan, so another officer must approve it", 403);
  if (action === "verify" && plan.reviewed_by_id === user.id) throw fail("You took this cash plan for verification, so another PCMED officer must verify it", 403);

  // Every handing-on step re-checks the whole plan against the current approved budget.
  if (["submit", "recommend", "approve"].includes(action)) {
    const state = await currentState(plan);
    if (state.validation.errors.length)
      throw fail(`The cash plan has ${state.validation.errors.length} error${state.validation.errors.length === 1 ? "" : "s"} to fix first`, 400, { validation: state.validation });
  }

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
  await plan.update(changes);
  if (action === "submit") await snapshot(plan, await currentState(plan), user);
  await logWorkflowEvent({ entityType: "cashPlan", record: plan, action, from, to: plan.status, comment: note, user });

  const where = `${plan.organization} FY ${plan.year}`;
  // Notification events use the existing list (created, reviewed, sent_to_pcmed, pcmed_approved…).
  if (action === "submit")
    await notifyNext(plan, user, "cashPlan.review", `${user.name} submitted the ${where} cash plan for review`, from === "Returned" ? "resubmitted" : "created");
  if (action === "recommend") await notifyNext(plan, user, "cashPlan.approve", `${user.name} recommended the ${where} cash plan for approval`, "reviewed");
  if (action === "approve") await notifyNext(plan, user, "pcmed.review", `${user.name} approved the ${where} cash plan and submitted it to PCMED`, "sent_to_pcmed");
  if (action === "startVerification") await notifyNext(plan, user, "pcmed.approve", `${user.name} took the ${where} cash plan for verification`, "pcmed_reviewed");
  if (action === "verify") await notifyNext(plan, user, "cashPlan.submit", `PCMED verified the ${where} cash plan`, "pcmed_approved");
  return currentState(plan);
}

/** Return the plan for correction (remarks required). It goes back to the preparer. */
export async function returnPlan(user, id, { comment }) {
  const plan = await loadPlanForUser(user, id);
  const from = plan.status;
  const permission = RETURN_PERMISSION[from];
  if (!permission) throw fail(`A cash plan that is ${STATUS_LABEL[from].toLowerCase()} cannot be returned`, 409);
  await assertPermission(user, permission);
  // Only the officer responsible for the current stage may return the plan.
  const stageActor = { PendingReview: "cashPlan.review", PendingApproval: "cashPlan.approve", SubmittedToPCMED: "pcmed.review", UnderVerification: "pcmed.approve" }[from];
  await assertPermission(user, stageActor);
  const note = String(comment ?? "").trim();
  if (!note) throw fail("Give the reason for returning the cash plan");
  await plan.update({ status: "Returned", return_reason: note, returned_by: user.name, returned_at: new Date(), returned_stage: from, revision: plan.revision + 1 });
  await logWorkflowEvent({ entityType: "cashPlan", record: plan, action: "return", from, to: "Returned", comment: note, user });
  await notifyNext(plan, user, "cashPlan.submit", `${user.name} returned the ${plan.organization} FY ${plan.year} cash plan for correction: ${note}`, from.startsWith("Pending") ? "returned" : "pcmed_returned");
  return currentState(plan);
}

export async function planHistory(user, id) {
  const plan = await loadPlanForUser(user, id);
  return workflowHistory("cashPlan", plan.id);
}

export async function planForExport(user, id) {
  const plan = await loadPlanForUser(user, id);
  return currentState(plan);
}

/**
 * Approved monthly requirements for allotment preparation: per activity ×
 * classification × funding source, for a DAD, year and (optionally) months.
 */
export async function approvedRequirements(user, { year, organization: requested, months }) {
  const organization = resolveOrganization(user, requested);
  await assertScope(user, organization);
  const plan = await CashPlan.findOne({ where: { year: Number(year), organization, status: "Verified" }, order: [["version", "DESC"]] });
  if (!plan) return { plan: null, lines: [] };
  const wanted = months ? String(months).split(",").map(Number).filter((m) => m >= 1 && m <= 12) : null;
  const lines = await CashPlanLine.findAll({
    where: { cash_plan_id: plan.id },
    include: [{ model: CashPlanAllocation, as: "allocations", where: wanted ? { month: { [Op.in]: wanted } } : undefined, required: false }],
  });
  return {
    plan: { id: plan.id, version: plan.version, approvedAt: plan.approved_at },
    lines: lines.map((l) => ({
      activityCode: l.activity_code,
      activity: l.activity,
      economicClassification: l.economic_classification,
      sourceOfFunding: l.source_of_funding,
      months: l.allocations.map((a) => ({ month: a.month, amount: Number(a.amount) })),
    })),
  };
}

/* ---------- activity mapping of budget lines (authorised PCMED officers) ---------- */

/** Budget lines of a DAD and year with no Activity/Operation code. */
export async function unmappedBudgetLines(user, { year, organization: requested }) {
  const organization = resolveOrganization(user, requested);
  await assertScope(user, organization);
  const rows = await LoadedData.findAll({
    where: { year: Number(year), organization, [Op.or]: [{ activityCode: null }, { activityCode: "" }] },
    order: [["economicClassification", "ASC"], ["sourceOfFunding", "ASC"], ["naturalAccount", "ASC"]],
  });
  return rows.map((r) => ({
    id: r.id,
    economicClassification: r.economicClassification,
    sourceOfFunding: r.sourceOfFunding,
    naturalAccount: r.naturalAccount,
    appropriation: Number(r.appropriation),
    activity: r.activity,
    policyClassification: r.policyClassification,
  }));
}

/**
 * Assign the Activity/Operation of one budget line. The code is entered by the
 * officer (never generated). Refused while the DAD's plan for that year is with
 * PCMED or approved, so a submitted plan never changes underneath its reviewers.
 */
export async function mapBudgetLine(user, id, { activityCode, activity, policyClassification }) {
  const row = await LoadedData.findByPk(id);
  if (!row) throw fail("Budget line not found", 404);
  await assertScope(user, row.organization);
  const code = String(activityCode ?? "").trim();
  const name = String(activity ?? "").trim();
  if (!code) throw fail("Enter the Activity/Operation code");
  if (code.length > 50) throw fail("The Activity/Operation code is too long");
  if (!name) throw fail("Enter the Activity/Operation description");
  if (name.length > 255) throw fail("The description is too long");
  const policy = policyClassification === "KPI" ? "KPI" : "Normal";
  const plan = await CashPlan.findOne({ where: { year: row.year, organization: row.organization }, order: [["version", "DESC"]] });
  if (plan && !EDITABLE.has(plan.status))
    throw fail(`The ${row.year} cash plan for ${row.organization} is ${(STATUS_LABEL[plan.status] ?? plan.status).toLowerCase()}; return it before changing its budget mapping`, 409);
  const before = row.activityCode ? `${row.activityCode} ${row.activity ?? ""}`.trim() : "unmapped";
  await row.update({ activityCode: code, activity: name, policyClassification: policy });
  await logWorkflowEvent({
    entityType: "budgetLine",
    record: { id: row.id, organization: row.organization, status: null },
    action: "activityMapped",
    from: null,
    to: null,
    comment: `${row.naturalAccount} (${row.economicClassification}, ${row.sourceOfFunding}, ${row.year}): ${before} → ${code} ${name}${policy === "KPI" ? " [KPI]" : ""}`,
    user,
  });
  return { id: row.id, activityCode: code, activity: name, policyClassification: policy };
}
