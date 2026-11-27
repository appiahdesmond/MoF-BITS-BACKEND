import Reallocation from "../models/reallocation.model.js";
import User from "../models/users.js";
import sequelize from "../config/database.js";
import { notifyOrganization, notifyPcmedStep, notifyRecordOpened } from "../utils/notify.js";
import { editStepError, workflowStepError } from "../utils/workflowGuard.js";
import { makeReturnHandler, notifyResubmitted } from "../utils/returnRecord.js";
import { logWorkflowEvent } from "../utils/workflowLog.js";
import { seesAllDads } from "../utils/dataScope.js";
import { canViewUnapproved } from "../utils/permissions.js";

export const addReallocation = async (req, res, next) => {
  //declare variable later a value will be assigned to it
  let reallocationTransaction;
  try {
    const {
      activity,
      date,
      economicClassification,
      sourceOfFunding,
      naturalAccount,
      description,
      amountReallocated,
      amountReleased,
      actualExpenditure,
      actualPayment,
      organization,
    } = req.body;

    const user = req.user;
    if (!user) {
      const error = new Error("Unauthorized: User not found.");
      error.statusCode = 401;
      throw error;
    }

    const requiredFields = [
      { key: "activity", value: activity },
      { key: "date", value: date },
      { key: "economicClassification", value: economicClassification },
      { key: "sourceOfFunding", value: sourceOfFunding },
      { key: "naturalAccount", value: naturalAccount },
      { key: "description", value: description },
    ];

    const missing = requiredFields.find((f) => !f.value);
    if (missing) {
      const error = new Error(`${missing.key} is required`);
      error.statusCode = 400;
      throw error;
    }
    

    // Open transaction only after validation passes
    reallocationTransaction = await sequelize.transaction();

    /* =========================
       DUPLICATE CHECK
    ========================== */
    const existing = await Reallocation.findOne({
      where: { activity, date },
      transaction: reallocationTransaction,
    });

    if (existing) {
      const error = new Error(
        "Record already exists for this activity and date",
      );
      error.statusCode = 400;
      throw error;
    }

    const reallocation = await Reallocation.create(
      {
        activity,
        date,
        economicClassification,
        sourceOfFunding,
        naturalAccount,
        description,
        amountReallocated,
        amountReleased,
        actualExpenditure,
        actualPayment,
        userId: user.id,
        organization: user.organization,
      },
      { transaction: reallocationTransaction },
    );

    await reallocationTransaction.commit();

    try {
      await notifyOrganization({
        organization: user.organization,
        actorId: user.id,
        entityType: "reallocation",
        entityId: reallocation.id,
        event: "created",
        message: `${user.name} submitted a new reallocation record`,
      });
    } catch (notifyError) {
      console.error("Failed to notify reviewers of new reallocation record:", notifyError);
    }

    await logWorkflowEvent({ entityType: "reallocation", record: reallocation, action: "submitted", from: null, to: "Pending", user: req.user });
    res.status(201).json({
      success: true,
      message: "Reallocation record added successfully",
      reallocation,
    });
  } catch (error) {
    if (reallocationTransaction) {
      await reallocationTransaction.rollback();
    }
    next(error);
  }
};

//Fetch all records
export const getAllReallocation = async (req, res, next) => {
  try {
    const user = req.user;

    // Ensure the user is authenticated
    if (!user) {
      const error = new Error("Unauthorized: User not found.");
      error.statusCode = 401;
      return next(error);
    }

    // Base filter
    let whereClause = {};

    // Data entry users should only see their own records
    if (user.role === "data_entry") {
      whereClause.userId = user.id;
    }

    // Everyone except admin is scoped to their own organization
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

    const records = await Reallocation.findAll({
      where: whereClause,
      include,
      order: [["createdAt", "DESC"]],
    });

    res.status(200).json({
      success: true,
      count: records.length,
      data: records,
    });
  } catch (error) {
    next(error);
  }
};

// Update record
export const updateReallocation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const updates = req.body || {};

    // Ensure the user is authenticated
    if (!user) {
      const error = new Error("Unauthorized: User not found.");
      error.statusCode = 401;
      return next(error);
    }

    const record = await Reallocation.findByPk(id);
    if (!record) {
      const error = new Error("Reallocation record not found");
      error.statusCode = 404;
      return next(error);
    }

    // Authorization
    if (record.userId !== user.id && user.role !== "admin") {
      const error = new Error("You are not authorized to update this record");
      error.statusCode = 403;
      return next(error);
    }

    // Prevent editing finalized records (if applicable)
    const editError = editStepError(record, user, "edit");
    if (editError) return next(editError);
    const previousStatus = record.status;
    // Corrected after a return by the DAD or by PCMED: back to DAD review.
    const resubmitted = ["Returned", "ReturnedByPCMED"].includes(record.status);

    // =========================
    // MERGE VALUES FIRST
    // =========================
    const amountReallocated = Number(
      updates.amountReallocated ?? record.amountReallocated ?? 0,
    );

    const actualExpenditure = Number(
      updates.actualExpenditure ?? record.actualExpenditure ?? 0,
    );

    const amountReleased = Number(
      updates.amountReleased ?? record.amountReleased ?? 0,
    );

    const actualPayment = Number(
      updates.actualPayment ?? record.actualPayment ?? 0,
    );

    // =========================
    // FINAL UPDATE OBJECT
    // =========================
    const updatedData = {
      activity: updates.activity ?? record.activity,
      date: updates.date ?? record.date,
      economicClassification:
        updates.economicClassification ?? record.economicClassification,
      sourceOfFunding: updates.sourceOfFunding ?? record.sourceOfFunding,
      naturalAccount: updates.naturalAccount ?? record.naturalAccount,
      description: updates.description ?? record.description,
      amountReallocated,
      amountReleased,
      actualExpenditure,
      actualPayment,
    };

    // Apply update
    if (resubmitted) updatedData.status = "Pending";
    await record.update(updatedData);

    if (resubmitted) await notifyResubmitted({ record, user: user, entityType: "reallocation", label: "Reallocation" });

    if (resubmitted) {

      await logWorkflowEvent({ entityType: "reallocation", record, action: "resubmitted", from: previousStatus, to: "Pending", user: req.user });

    }

    res.status(200).json({
      success: true,
      message: "Reallocation record updated successfully",
      data: record,
    });
  } catch (error) {
    next(error);
  }
};

// Delete Reallocation record
export const deleteReallocation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = req.user;

    // Ensure the user is authenticated
    if (!user) {
      const error = new Error("Unauthorized: User not found.");
      error.statusCode = 401;
      return next(error);
    }

    const record = await Reallocation.findByPk(id);
    if (!record) {
      const error = new Error("Reallocation record not found");
      error.statusCode = 404;
      return next(error);
    }

    // Ownership check: Only creator or admin can delete
    if (record.userId !== user.id && user.role !== "admin") {
      const error = new Error("You are not authorized to delete this record");
      error.statusCode = 403;
      return next(error);
    }

    // Prevent deleting reviewed or approved records
    const editError = editStepError(record, user, "delete");
    if (editError) return next(editError);

    await record.destroy();

    res.status(200).json({
      success: true,
      message: "Reallocation record deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

//  Review Reallocation record (Reviewer only)
export const reviewReallocation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reviewComment } = req.body; // optional comment from frontend
    const user = req.user; // reviewer info from auth middleware

    // Ensure the user is authenticated
    if (!user) {
      const error = new Error("Unauthorized: User not found.");
      error.statusCode = 401;
      return next(error);
    }

    // Fetch the Reallocation record
    const record = await Reallocation.findByPk(id);

    if (!record) {
      const error = new Error("Reallocation record not found");
      error.statusCode = 404;
      return next(error);
    }

    const stepError = workflowStepError(record, user, "review");
    if (stepError) return next(stepError);

    // Prevent re-review if already reviewed or approved
    if (record.status === "Reviewed" || record.status === "Approved") {
      const error = new Error("This record has already been reviewed");
      error.statusCode = 400;
      return next(error);
    }

    // Update record fields
    record.status = "Reviewed";
    record.reviewedBy = user.name;
    record.reviewedAt = new Date();
    record.reviewComment = reviewComment || null;

    await record.save();
    await logWorkflowEvent({ entityType: "reallocation", record: record, action: "dad_reviewed", from: "Pending", to: "Reviewed", comment: record.reviewComment, user: req.user });

    try {
      await notifyOrganization({
        organization: record.organization,
        actorId: user.id,
        entityType: "reallocation",
        entityId: record.id,
        event: "reviewed",
        message: `${user.name} reviewed a reallocation record`,
      });
    } catch (notifyError) {
      console.error("Failed to notify approvers of reviewed reallocation record:", notifyError);
    }

    // Send back updated record
    res.status(200).json({
      success: true,
      message: "Reallocation record reviewed successfully",
      data: record,
    });
  } catch (error) {
    next(error);
  }
};

// Approve Reallocation record (Approver only)
export const approveReallocation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = req.user;

    if (!user) {
      const error = new Error("Unauthorized: User not found.");
      error.statusCode = 401;
      return next(error);
    }

    const record = await Reallocation.findByPk(id);
    if (!record) {
      const error = new Error("Reallocation record not found");
      error.statusCode = 404;
      return next(error);
    }

    const stepError = workflowStepError(record, user, "approve");
    if (stepError) return next(stepError);

    //Must be reviewed first
    if (record.status !== "Reviewed") {
      const error = new Error("Only reviewed records can be approved");
      error.statusCode = 400;
      return next(error);
    }

    //Prevent double approval
    if (record.status === "Approved") {
      const error = new Error("This record is already approved");
      error.statusCode = 400;
      return next(error);
    }

    //Optional: prevent self-approval
    // if (record.userId === user.id) {
    //   const error = new Error("You cannot approve your own record");
    //   error.statusCode = 400;
    //   return next(error);
    // }

    // Approver marks record as approved
    // DAD approval sends the record to PCMED; PCMED gives final approval.
    record.status = "PendingPCMEDReview";
    record.approvedBy = user.name;
    record.approvedAt = new Date();

    await record.save();
    await logWorkflowEvent({ entityType: "reallocation", record, action: "dad_approved", from: "Reviewed", to: "PendingPCMEDReview", user: req.user });
    try {
      await notifyPcmedStep({
        record,
        actorId: req.user.id,
        entityType: "reallocation",
        event: "sent_to_pcmed",
        permission: "pcmed.review",
        message: `${req.user.name} approved a reallocation record from ${record.organization} for PCMED review`,
      });
    } catch (notifyError) {
      console.error("Failed to notify PCMED reviewers:", notifyError);
    }

    try {
      await notifyOrganization({
        organization: record.organization,
        actorId: user.id,
        entityType: "reallocation",
        entityId: record.id,
        event: "approved",
        message: `${user.name} approved a reallocation record and sent it to PCMED`,
      });
    } catch (notifyError) {
      console.error("Failed to update reallocation approval notifications:", notifyError);
    }

    res.status(200).json({
      success: true,
      message: "Reallocation record approved and sent to PCMED for review",
      data: record,
    });
  } catch (error) {
    next(error);
  }
};

export const markReallocationViewed = async (req, res, next) => {
  try {
    const user = req.user;
    const record = await Reallocation.findByPk(req.params.id);
    if (!record) {
      const error = new Error("Reallocation record not found");
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
      entityType: "reallocation",
      label: "reallocation record",
    });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};


// PATCH /:id/return — send back to the data entry officer for correction.
export const returnReallocation = makeReturnHandler({
  Model: Reallocation,
  entityType: "reallocation",
  label: "Reallocation",
});
