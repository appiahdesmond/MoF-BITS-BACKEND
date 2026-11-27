// PCMED review and final approval of DAD-approved records (all four record types).
//
//   PendingPCMEDReview   –review→  PendingPCMEDApproval  –approve→  Approved
//   PendingPCMEDReview   –return→  ReturnedByPCMED (back to the originating DAD)
//   PendingPCMEDApproval –return→  PendingPCMEDReview (back to PCMED for further examination)
//
// Every action checks the user's permission (routes), their data scope (assigned
// DADs) and the record's status here. The officer who reviewed a record cannot give
// it final approval. PCMED never edits a DAD's figures.
import { Op } from "sequelize";
import Revenue from "../models/revenue.model.js";
import Cash from "../models/cash.model.js";
import BudgetExpenditure from "../models/expenditure.model.js";
import Reallocation from "../models/reallocation.model.js";
import { dadScope, inScope } from "../utils/dataScope.js";
import { logWorkflowEvent, workflowHistory } from "../utils/workflowLog.js";
import { notifyOrganization, notifyPcmedStep } from "../utils/notify.js";
import { WorkflowEvent } from "../models/workflow.model.js";

/** A PCMED step is overdue after this many days. */
export const OVERDUE_DAYS = 5;

const ENTITIES = {
  revenue: {
    Model: Revenue,
    label: "IGF revenue",
    dateField: "date",
    amount: (r) => r.actual_collection,
    summary: (r) => r.revenue_category,
  },
  cash: {
    Model: Cash,
    label: "Cash position",
    dateField: "as_at_date",
    amount: (r) => r.balance,
    summary: (r) => `${r.account_name} · ${r.currency === "GHS" ? "GH₵" : r.currency}`,
    currency: (r) => r.currency,
  },
  expenditure: {
    Model: BudgetExpenditure,
    label: "Expenditure",
    dateField: "date",
    amount: (r) => r.actualExpenditure,
    summary: (r) => [r.activity, r.economicClassification].filter(Boolean).join(" · "),
  },
  reallocation: {
    Model: Reallocation,
    label: "Reallocation",
    dateField: "date",
    amount: (r) => r.amountReallocated,
    summary: (r) => [r.activity, r.economicClassification].filter(Boolean).join(" · "),
  },
};

/** "an IGF revenue record", "a cash position record", "an expenditure record". */
const recordNoun = (entity) => {
  const label = entity.label === "IGF revenue" ? "IGF revenue" : entity.label.toLowerCase();
  return `${/^[aeiouAEIOU]/.test(label) ? "an" : "a"} ${label} record`;
};

const STAGES = {
  review: ["PendingPCMEDReview"],
  approval: ["PendingPCMEDApproval"],
  decided: ["Approved", "ReturnedByPCMED"],
};

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

/** A record as shown in the workbenches. */
function row(type, record) {
  const e = ENTITIES[type];
  return {
    type,
    typeLabel: e.label,
    id: record.id,
    organization: record.organization,
    date: record[e.dateField],
    summary: e.summary(record),
    amount: Number(e.amount(record)) || 0,
    currency: e.currency ? e.currency(record) : "GHS",
    status: record.status,
    dadReviewedBy: record.reviewedBy,
    dadReviewedAt: record.reviewedAt,
    dadApprovedBy: record.approvedBy,
    dadApprovedAt: record.approvedAt,
    pcmedReviewedBy: record.pcmedReviewedBy,
    pcmedReviewedById: record.pcmedReviewedById,
    pcmedReviewedAt: record.pcmedReviewedAt,
    pcmedReviewComment: record.pcmedReviewComment,
    pcmedApprovedBy: record.pcmedApprovedBy,
    pcmedApprovedAt: record.pcmedApprovedAt,
    returnReason: record.returnReason,
    updatedAt: record.updatedAt,
  };
}

// GET /api/pcmed/queue?stage=review|approval|decided&type=&organization=
export const getQueue = async (req, res, next) => {
  try {
    const stage = STAGES[req.query.stage] ? req.query.stage : "review";
    const scope = await dadScope(req.user);
    const types = ENTITIES[req.query.type] ? [req.query.type] : Object.keys(ENTITIES);
    const orgFilter = req.query.organization ? String(req.query.organization) : null;
    if (orgFilter && !inScope(scope, orgFilter)) return res.json({ success: true, data: [], scope });
    const orgWhere = orgFilter
      ? { organization: orgFilter }
      : scope.all
        ? {}
        : { organization: { [Op.in]: scope.organizations } };

    const where = { status: { [Op.in]: STAGES[stage] }, ...orgWhere };
    if (stage === "decided") {
      // Records PCMED has decided on: approved by PCMED or returned by PCMED.
      where[Op.or] = [{ pcmedApprovedAt: { [Op.ne]: null } }, { status: "ReturnedByPCMED" }];
    }
    const rows = [];
    for (const type of types) {
      const { Model } = ENTITIES[type];
      const records = await Model.findAll({
        where,
        order: [["updatedAt", stage === "decided" ? "DESC" : "ASC"]],
        limit: stage === "decided" ? 100 : 1000,
      });
      records.forEach((r) => rows.push(row(type, r)));
    }
    rows.sort((a, b) =>
      stage === "decided"
        ? new Date(b.updatedAt) - new Date(a.updatedAt)
        : new Date(a.dadApprovedAt || a.updatedAt) - new Date(b.dadApprovedAt || b.updatedAt),
    );
    res.json({ success: true, data: rows, scope });
  } catch (error) {
    next(error);
  }
};

async function loadInScope(req) {
  const entity = ENTITIES[req.params.type];
  if (!entity) throw fail(404, "Unknown record type");
  const record = await entity.Model.findByPk(req.params.id);
  if (!record) throw fail(404, `${entity.label} record not found`);
  if (!inScope(await dadScope(req.user), record.organization)) {
    throw fail(403, "This record belongs to a DAD outside your assigned scope");
  }
  return { entity, record };
}

// GET /api/pcmed/:type/:id — the record, the full record, and its workflow history.
export const getRecord = async (req, res, next) => {
  try {
    const { record } = await loadInScope(req);
    res.json({
      success: true,
      data: row(req.params.type, record),
      record,
      history: await workflowHistory(req.params.type, record.id),
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/pcmed/:type/:id/review  { comment } — validated; recommend for final approval.
export const reviewRecord = async (req, res, next) => {
  try {
    const { entity, record } = await loadInScope(req);
    if (record.status !== "PendingPCMEDReview") {
      throw fail(409, "Only records waiting for PCMED review can be reviewed");
    }
    const comment = String(req.body?.comment ?? "").trim() || null;
    const user = req.user;
    record.status = "PendingPCMEDApproval";
    record.pcmedReviewedBy = user.name;
    record.pcmedReviewedById = user.id;
    record.pcmedReviewedAt = new Date();
    record.pcmedReviewComment = comment;
    await record.save();
    await logWorkflowEvent({
      entityType: req.params.type,
      record,
      action: "pcmed_reviewed",
      from: "PendingPCMEDReview",
      to: "PendingPCMEDApproval",
      comment,
      user,
    });
    try {
      await notifyPcmedStep({
        record,
        actorId: user.id,
        entityType: req.params.type,
        event: "pcmed_reviewed",
        permission: "pcmed.approve",
        message: `${user.name} recommended ${recordNoun(entity)} from ${record.organization} for final approval`,
      });
    } catch (notifyError) {
      console.error("Failed to notify PCMED approvers:", notifyError);
    }
    res.json({ success: true, message: "Recommended for final approval", data: row(req.params.type, record) });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/pcmed/:type/:id/approve  { comment } — final approval (verified data).
export const approveRecord = async (req, res, next) => {
  try {
    const { entity, record } = await loadInScope(req);
    if (record.status !== "PendingPCMEDApproval") {
      throw fail(409, "Only records recommended by a PCMED reviewer can be given final approval");
    }
    const user = req.user;
    if (record.pcmedReviewedById && record.pcmedReviewedById === user.id) {
      throw fail(403, "You reviewed this record, so another officer must give final approval");
    }
    const comment = String(req.body?.comment ?? "").trim() || null;
    record.status = "Approved";
    record.pcmedApprovedBy = user.name;
    record.pcmedApprovedById = user.id;
    record.pcmedApprovedAt = new Date();
    record.pcmedApprovalComment = comment;
    await record.save();
    await logWorkflowEvent({
      entityType: req.params.type,
      record,
      action: "pcmed_approved",
      from: "PendingPCMEDApproval",
      to: "Approved",
      comment,
      user,
    });
    try {
      await notifyOrganization({
        organization: record.organization,
        actorId: user.id,
        entityType: req.params.type,
        entityId: record.id,
        event: "pcmed_approved",
        message: `${user.name} (PCMED) gave final approval to ${recordNoun(entity)}`,
      });
    } catch (notifyError) {
      console.error("Failed to notify the DAD of final approval:", notifyError);
    }
    res.json({ success: true, message: "Final approval granted", data: row(req.params.type, record) });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/pcmed/:type/:id/return  { reason }
//   waiting for PCMED review   → returned to the originating DAD (needs pcmed.review)
//   waiting for final approval → back to PCMED review (needs pcmed.approve)
export const returnRecord = async (req, res, next) => {
  try {
    const { entity, record } = await loadInScope(req);
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) throw fail(400, "Please give a reason for returning this record");
    if (reason.length > 1000) throw fail(400, "The reason must be 1000 characters or fewer");
    const user = req.user;
    const perms = user.permissions || {};
    const from = record.status;

    if (from === "PendingPCMEDReview") {
      if (!perms["pcmed.review"]) throw fail(403, "Your role cannot return records at PCMED review");
      record.status = "ReturnedByPCMED";
      record.returnReason = reason;
      record.returnedBy = `${user.name} (PCMED)`;
      record.returnedAt = new Date();
    } else if (from === "PendingPCMEDApproval") {
      if (!perms["pcmed.approve"]) throw fail(403, "Your role cannot return records at final approval");
      record.status = "PendingPCMEDReview";
      record.pcmedApprovalComment = reason;
    } else {
      throw fail(409, "Only records with PCMED can be returned here");
    }
    await record.save();
    await logWorkflowEvent({
      entityType: req.params.type,
      record,
      action: from === "PendingPCMEDReview" ? "pcmed_returned_to_dad" : "pcmed_returned_for_review",
      from,
      to: record.status,
      comment: reason,
      user,
    });
    try {
      if (record.status === "ReturnedByPCMED") {
        await notifyOrganization({
          organization: record.organization,
          actorId: user.id,
          entityType: req.params.type,
          entityId: record.id,
          event: "pcmed_returned",
          message: `${user.name} (PCMED) returned ${recordNoun(entity)} for correction`,
        });
      } else {
        await notifyPcmedStep({
          record,
          actorId: user.id,
          entityType: req.params.type,
          event: "pcmed_returned",
          permission: "pcmed.review",
          message: `${user.name} returned ${recordNoun(entity)} from ${record.organization} for further examination`,
        });
      }
    } catch (notifyError) {
      console.error("Failed to notify about a PCMED return:", notifyError);
    }
    res.json({
      success: true,
      message:
        record.status === "ReturnedByPCMED"
          ? "Returned to the DAD for correction"
          : "Returned to PCMED review for further examination",
      data: row(req.params.type, record),
    });
  } catch (error) {
    next(error);
  }
};

/** Organisation filter for the user's data scope. */
function scopeWhere(scope) {
  return scope.all ? {} : { organization: { [Op.in]: scope.organizations } };
}

async function countAll(where) {
  let n = 0;
  for (const { Model } of Object.values(ENTITIES)) n += await Model.count({ where });
  return n;
}

// GET /api/pcmed/counts — records waiting at each PCMED step (sidebar badges).
export const getCounts = async (req, res, next) => {
  try {
    const sw = scopeWhere(await dadScope(req.user));
    res.json({
      success: true,
      review: await countAll({ ...sw, status: "PendingPCMEDReview" }),
      approval: await countAll({ ...sw, status: "PendingPCMEDApproval" }),
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/pcmed/summary — PCMED workload and performance for the dashboard.
export const getSummary = async (req, res, next) => {
  try {
    const scope = await dadScope(req.user);
    const sw = scopeWhere(scope);
    const now = new Date();
    const overdueBefore = new Date(now.getTime() - OVERDUE_DAYS * 86400000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = { [Op.gte]: monthStart };

    const reviewed = [];
    const approved = [];
    for (const { Model } of Object.values(ENTITIES)) {
      reviewed.push(...(await Model.findAll({ where: { ...sw, pcmedReviewedAt: thisMonth }, attributes: ["approvedAt", "pcmedReviewedAt"] })));
      approved.push(...(await Model.findAll({ where: { ...sw, pcmedApprovedAt: thisMonth }, attributes: ["pcmedReviewedAt", "pcmedApprovedAt"] })));
    }
    const avgDays = (rows, a, b) => {
      const spans = rows.filter((r) => r[a] && r[b]).map((r) => (new Date(r[b]) - new Date(r[a])) / 86400000);
      return spans.length ? spans.reduce((x, y) => x + y, 0) / spans.length : null;
    };
    const events = (action) =>
      WorkflowEvent.count({ where: { action, created_at: thisMonth, ...(scope.all ? {} : { organization: { [Op.in]: scope.organizations } }) } });

    res.json({
      success: true,
      overdueDays: OVERDUE_DAYS,
      pendingReview: await countAll({ ...sw, status: "PendingPCMEDReview" }),
      overdueReview: await countAll({ ...sw, status: "PendingPCMEDReview", approvedAt: { [Op.lt]: overdueBefore } }),
      pendingApproval: await countAll({ ...sw, status: "PendingPCMEDApproval" }),
      overdueApproval: await countAll({ ...sw, status: "PendingPCMEDApproval", pcmedReviewedAt: { [Op.lt]: overdueBefore } }),
      recommendedThisMonth: reviewed.length,
      approvedThisMonth: approved.length,
      returnedToDadThisMonth: await events("pcmed_returned_to_dad"),
      returnedForReviewThisMonth: await events("pcmed_returned_for_review"),
      avgReviewDays: avgDays(reviewed, "approvedAt", "pcmedReviewedAt"),
      avgApprovalDays: avgDays(approved, "pcmedReviewedAt", "pcmedApprovedAt"),
    });
  } catch (error) {
    next(error);
  }
};
