import Revenue from "../models/revenue.model.js";
import User from "../models/users.js";
import Organization from "../models/organization.model.js";
import { notifyOrganization, notifyPcmedStep, notifyRecordOpened } from "../utils/notify.js";
import { editStepError, workflowStepError } from "../utils/workflowGuard.js";
import { makeReturnHandler, notifyResubmitted } from "../utils/returnRecord.js";
import { retentionRateOn } from "../utils/retentionRate.js";
import { logWorkflowEvent } from "../utils/workflowLog.js";
import { seesAllDads } from "../utils/dataScope.js";
import { canViewUnapproved } from "../utils/permissions.js";

/**
 * Helper to compute retention + payment from C and rate
 */
const computeRetentionAndPayment = (actualCollection, retentionRate) => {
    //Convert inputs to numbers
  const C = Number(actualCollection);
  const rate = Number(retentionRate);

  if (Number.isNaN(C) || C < 0) {
    throw new Error("Actual collection must be a valid non-negative number");
  }

  if (Number.isNaN(rate) || rate < 0) {
    throw new Error("Invalid retention rate for this organization");
  }

  const retentionAmount = (rate / 100) * C; // E
  const paymentAmount = C - retentionAmount; // D

  return {
    C,
    retentionAmount: Number(retentionAmount.toFixed(2)),
    paymentAmount: Number(paymentAmount.toFixed(2)),
  };
};

/**
 * ADD REVENUE
 */
export const addRevenue = async (req, res, next) => {
  try {
    const {
      date,
      revenueCategory,
      actualCollection,
      budgetProjections,
      remarks,
    } = req.body;

    const revenue_category = revenueCategory;

    const user = req.user;
    if (!user) {
      const error = new Error("Unauthorized: User not found.");
      error.statusCode = 401;
      return next(error);
    }

    // Required fields
    const requiredFields = [
      { key: "date", value: date },
      { key: "revenueCategory", value: revenue_category },
      { key: "actualCollection", value: actualCollection },
    ];

    const missing = requiredFields.filter((field) => !field.value && field.value !== 0);
    if (missing.length > 0) {
      const error = new Error(`${missing[0].key} is required`);
      error.statusCode = 400;
      return next(error);
    }

    // Retention rate in force on the collection date (rates can change over time).
    const org = await Organization.findOne({ where: { name: user.organization } });
    const retentionRate = org ? await retentionRateOn(org, date) : null;
    if (retentionRate === null || retentionRate === undefined) {
      const error = new Error(
        "Retention rate not configured for this organization. Ask an admin to set it under System Management > Financial Configuration > IGF Retention Management."
      );
      error.statusCode = 400;
      return next(error);
    }

    // Optional: prevent duplicate revenue for same date & category in same org
    const existing = await Revenue.findOne({
      where: {
        date,
        revenue_category,
        organization: user.organization,
      },
    });

    if (existing) {
      const error = new Error(
        "Revenue record already exists for this date and category"
      );
      error.statusCode = 400;
      return next(error);
    }

    // Compute amounts
    const { C, retentionAmount, paymentAmount } = computeRetentionAndPayment(
      actualCollection,
      retentionRate
    );

    const revenue = await Revenue.create({
      user_id: user.id,
      organization: user.organization,
      retention_rate: retentionRate,
      date,
      revenue_category,
      actual_collection: C,
      retention_amount: retentionAmount,
      payment_amount: paymentAmount,
      budgetProjections,
      remarks: remarks ?? null,
      status: "Pending",
    });

    try {
      await notifyOrganization({
        organization: user.organization,
        actorId: user.id,
        entityType: "revenue",
        entityId: revenue.id,
        event: "created",
        message: `${user.name} submitted a new ${revenue.revenue_category} revenue record`,
      });
    } catch (notifyError) {
      console.error("Failed to notify reviewers of new revenue record:", notifyError);
    }

    await logWorkflowEvent({ entityType: "revenue", record: revenue, action: "submitted", from: null, to: "Pending", user: req.user });
    res.status(201).json({
      success: true,
      message: "Revenue record added successfully",
      record: revenue,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET ALL REVENUE
 */
export const getAllRevenue = async (req, res, next) => {
  try {
    const user = req.user;

    let whereClause = {};

    // data_entry can only see their own records
    if (user.role === "data_entry") {
      whereClause.user_id = user.id;
    }

    // Everyone except admin is scoped to their own organization.
    // Filtering directly on Revenue.organization (not via the User include)
    // so it applies as a real WHERE on the parent query regardless of join type.
    if (!seesAllDads(user)) {
      whereClause.organization = user.organization;
    }
    // Roles that see only approved data (e.g. executives) never get unapproved records.
    if (!(await canViewUnapproved(user))) whereClause.status = "Approved";

    const include = [
      {
        model: User,
        attributes: ["id", "name", "organization", "role"],
      },
    ];

    const revenues = await Revenue.findAll({
      where: whereClause,
      include,
      order: [["createdAt", "DESC"]],
    });

    res.status(200).json({
      success: true,
      count: revenues.length,
      data: revenues,
    });
  } catch (error) {
    console.error("Error fetching revenues:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch revenues",
    });
  }
};

/**
 * UPDATE REVENUE
 */
export const updateRevenue = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const updates = req.body;

    const record = await Revenue.findByPk(id);
    if (!record) {
      const error = new Error("Revenue record not found");
      error.statusCode = 404;
      return next(error);
    }

    // Only creator or admin can update
    if (record.user_id !== user.id && user.role !== "admin") {
      const error = new Error("You are not authorized to update this record");
      error.statusCode = 403;
      return next(error);
    }

    // No editing if Reviewed / Approved
    const editError = editStepError(record, user, "edit");
    if (editError) return next(editError);
    const previousStatus = record.status;
    // Corrected after a return by the DAD or by PCMED: back to DAD review.
    const resubmitted = ["Returned", "ReturnedByPCMED"].includes(record.status);

    // Map camelCase from frontend to DB columns
    if (updates.date !== undefined) {
      record.date = updates.date;
    }

    if (updates.revenueCategory !== undefined) {
      record.revenue_category = updates.revenueCategory;
    }

    if (updates.remarks !== undefined) {
      record.remarks = updates.remarks;
    }

    // If actualCollection changed, recompute retention + payment
    if (updates.actualCollection !== undefined) {
      const { C, retentionAmount, paymentAmount } = computeRetentionAndPayment(
        updates.actualCollection,
        record.retention_rate
      );

      record.actual_collection = C;
      record.retention_amount = retentionAmount;
      record.payment_amount = paymentAmount;
    }

    // Ignore any direct attempts to set retention_amount / payment_amount
    if (resubmitted) record.status = "Pending";
    await record.save();

    if (resubmitted) await notifyResubmitted({ record, user: user, entityType: "revenue", label: "Revenue" });

    if (resubmitted) {

      await logWorkflowEvent({ entityType: "revenue", record, action: "resubmitted", from: previousStatus, to: "Pending", user: req.user });

    }

    res.status(200).json({
      success: true,
      message: "Revenue record updated successfully",
      data: record,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE REVENUE
 */
export const deleteRevenue = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const record = await Revenue.findByPk(id);
    if (!record) {
      const error = new Error("Revenue record not found");
      error.statusCode = 404;
      return next(error);
    }

    // Only creator or admin can delete
    if (record.user_id !== user.id && user.role !== "admin") {
      const error = new Error("You are not authorized to delete this record");
      error.statusCode = 403;
      return next(error);
    }

    // No deleting if Reviewed / Approved
    const editError = editStepError(record, user, "delete");
    if (editError) return next(editError);

    await record.destroy();

    res.status(200).json({
      success: true,
      message: "Revenue record deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

/**
 * APPROVE REVENUE
 */
export const approveRevenue = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const record = await Revenue.findByPk(id);
    if (!record) {
      const error = new Error("Revenue record not found");
      error.statusCode = 404;
      return next(error);
    }

    const stepError = workflowStepError(record, user, "approve");
    if (stepError) return next(stepError);

    // DAD approval sends the record to PCMED; PCMED gives final approval.
    record.status = "PendingPCMEDReview";
    record.approvedBy = user.name;
    record.approvedAt = new Date();

    await record.save();
    await logWorkflowEvent({ entityType: "revenue", record, action: "dad_approved", from: "Reviewed", to: "PendingPCMEDReview", user: req.user });
    try {
      await notifyPcmedStep({
        record,
        actorId: req.user.id,
        entityType: "revenue",
        event: "sent_to_pcmed",
        permission: "pcmed.review",
        message: `${req.user.name} approved a revenue record from ${record.organization} for PCMED review`,
      });
    } catch (notifyError) {
      console.error("Failed to notify PCMED reviewers:", notifyError);
    }

    try {
      await notifyOrganization({
        organization: record.organization,
        actorId: user.id,
        entityType: "revenue",
        entityId: record.id,
        event: "approved",
        message: `${user.name} approved a revenue record and sent it to PCMED`,
      });
    } catch (notifyError) {
      console.error("Failed to update revenue approval notifications:", notifyError);
    }

    res.status(200).json({
      success: true,
      message: "Revenue record approved and sent to PCMED for review",
      data: record,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * REVIEW REVENUE
 */
export const reviewRevenue = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reviewComment } = req.body;
    const user = req.user;

    if (!user) {
      const error = new Error("Unauthorized: User not found.");
      error.statusCode = 401;
      return next(error);
    }

    const record = await Revenue.findByPk(id);
    if (!record) {
      const error = new Error("Revenue record not found");
      error.statusCode = 404;
      return next(error);
    }

    const stepError = workflowStepError(record, user, "review");
    if (stepError) return next(stepError);

    if (record.status === "Reviewed" || record.status === "Approved") {
      const error = new Error("This record has already been reviewed");
      error.statusCode = 400;
      return next(error);
    }

    record.status = "Reviewed";
    record.reviewedBy = user.name;
    record.reviewedAt = new Date();
    record.reviewComment = reviewComment || null;

    await record.save();
    await logWorkflowEvent({ entityType: "revenue", record: record, action: "dad_reviewed", from: "Pending", to: "Reviewed", comment: record.reviewComment, user: req.user });

    try {
      await notifyOrganization({
        organization: record.organization,
        actorId: user.id,
        entityType: "revenue",
        entityId: record.id,
        event: "reviewed",
        message: `${user.name} reviewed a revenue record`,
      });
    } catch (notifyError) {
      console.error("Failed to notify approvers of reviewed revenue record:", notifyError);
    }

    res.status(200).json({
      success: true,
      message: "Revenue record reviewed successfully",
      data: record,
    });
  } catch (error) {
    next(error);
  }
};

export const markRevenueViewed = async (req, res, next) => {
  try {
    const user = req.user;
    const record = await Revenue.findByPk(req.params.id);
    if (!record) {
      const error = new Error("Revenue record not found");
      error.statusCode = 404;
      return next(error);
    }
    if (record.organization !== user.organization) {
      const error = new Error("You cannot open a record outside your organization");
      error.statusCode = 403;
      return next(error);
    }

    await notifyRecordOpened({
      actor: user,
      record,
      entityType: "revenue",
      label: "revenue record",
    });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};


// PATCH /:id/return — send back to the data entry officer for correction.
export const returnRevenue = makeReturnHandler({
  Model: Revenue,
  entityType: "revenue",
  label: "Revenue",
});
