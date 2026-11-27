import Cash from "../models/cash.model.js";
import User from "../models/users.js";
import { notifyOrganization, notifyPcmedStep, notifyRecordOpened } from "../utils/notify.js";
import { editStepError, workflowStepError } from "../utils/workflowGuard.js";
import { makeReturnHandler, notifyResubmitted } from "../utils/returnRecord.js";
import { logWorkflowEvent } from "../utils/workflowLog.js";
import { seesAllDads } from "../utils/dataScope.js";
import { canViewUnapproved } from "../utils/permissions.js";

export const addCashPosition = async (req, res, next) => {
  try {
    const { as_at_date, account_name, currency, balance } = req.body;

    const user = req.user;
    if (!user) {
      const error = new Error("Unauthorized: User not found.");
      error.statusCode = 401;
      return next(error);
    }

    // Required fields
    const requiredFields = [
      { key: "as_at_date", value: as_at_date },
      { key: "account_name", value: account_name },
      { key: "currency", value: currency },
      { key: "balance", value: balance },
    ];

    //checking if required fields were actually sent in the request body.
    const missing = requiredFields.filter(
      (field) => field.value === undefined || field.value === null,
    );

    // if at least one required field is missing

    if (missing.length > 0) {
      // take the first missing field
      const error = new Error(`${missing[0].key} is required`);
      error.statusCode = 400;
      return next(error);
    }

    const record = await Cash.create({
      user_id: user.id,
      organization: user.organization,
      as_at_date,
      account_name,
      currency,
      balance,
      status: "Pending",
    });

    try {
      await notifyOrganization({
        organization: user.organization,
        actorId: user.id,
        entityType: "cash",
        entityId: record.id,
        event: "created",
        message: `${user.name} submitted a new cash position`,
      });
    } catch (notifyError) {
      console.error("Failed to notify reviewers of new cash position:", notifyError);
    }

    await logWorkflowEvent({ entityType: "cash", record: record, action: "submitted", from: null, to: "Pending", user: req.user });
    res.status(201).json({
      success: true,
      message: "Cash position added successfully",
      record,
    });
  } catch (error) {
    next(error);
  }
};

export const getAllCashPositions = async (req, res, next) => {
  try {
    const user = req.user;
    let whereClause = {};

    // data_entry sees only their own
    if (user.role === "data_entry") {
      whereClause.user_id = user.id;
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

    const records = await Cash.findAll({
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

export const updateCashPosition = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const updates = req.body;

    const record = await Cash.findByPk(id);
    if (!record) {
      const error = new Error("Cash position record not found");
      error.statusCode = 404;
      return next(error);
    }

    if (record.user_id !== user.id && user.role !== "admin") {
      const error = new Error("You are not authorized to update this record");
      error.statusCode = 403;
      return next(error);
    }

    const editError = editStepError(record, user, "edit");
    if (editError) return next(editError);
    const previousStatus = record.status;
    // Corrected after a return by the DAD or by PCMED: back to DAD review.
    const resubmitted = ["Returned", "ReturnedByPCMED"].includes(record.status);

    // Allowed updates
    if (updates.as_at_date !== undefined)
      record.as_at_date = updates.as_at_date;
    if (updates.account_name !== undefined)
      record.account_name = updates.account_name;
    if (updates.currency !== undefined) record.currency = updates.currency;
    if (updates.balance !== undefined) record.balance = updates.balance;

    if (resubmitted) record.status = "Pending";
    await record.save();

    if (resubmitted) await notifyResubmitted({ record, user: user, entityType: "cash", label: "Cash position" });

    if (resubmitted) {

      await logWorkflowEvent({ entityType: "cash", record, action: "resubmitted", from: previousStatus, to: "Pending", user: req.user });

    }

    res.status(200).json({
      success: true,
      message: "Cash position updated successfully",
      data: record,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteCashPosition = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const record = await Cash.findByPk(id);
    if (!record) {
      const error = new Error("Cash position record not found");
      error.statusCode = 404;
      return next(error);
    }

    if (record.user_id !== user.id && user.role !== "admin") {
      const error = new Error("You are not authorized to delete this record");
      error.statusCode = 403;
      return next(error);
    }

    const editError = editStepError(record, user, "delete");
    if (editError) return next(editError);

    await record.destroy();

    res.status(200).json({
      success: true,
      message: "Cash position deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

export const reviewCashPosition = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reviewComment } = req.body;
    const user = req.user;

    if (!user) {
      const error = new Error("Unauthorized: User not found.");
      error.statusCode = 401;
      return next(error);
    }

    const cash = await Cash.findByPk(id);

    if (!cash) {
      const error = new Error("Cash position record not found");
      error.statusCode = 404;
      return next(error);
    }

    const stepError = workflowStepError(cash, user, "review");
    if (stepError) return next(stepError);

    if (cash.status !== "Pending") {
      const error = new Error("Only pending records can be reviewed");
      error.statusCode = 400;
      return next(error);
    }

    cash.status = "Reviewed";
    cash.reviewedBy = user.name;
    cash.reviewedAt = new Date();
    cash.reviewComment = reviewComment || null;

    await cash.save();
    await logWorkflowEvent({ entityType: "cash", record: cash, action: "dad_reviewed", from: "Pending", to: "Reviewed", comment: cash.reviewComment, user: req.user });

    try {
      await notifyOrganization({
        organization: cash.organization,
        actorId: user.id,
        entityType: "cash",
        entityId: cash.id,
        event: "reviewed",
        message: `${user.name} reviewed a cash position`,
      });
    } catch (notifyError) {
      console.error("Failed to notify approvers of reviewed cash position:", notifyError);
    }

    res.status(200).json({
      success: true,
      message: "Cash position reviewed successfully",
      data: cash,
    });
  } catch (error) {
    next(error);
  }
};

export const approveCashPosition = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const record = await Cash.findByPk(id);
    if (!record) {
      const error = new Error("Cash position record not found");
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
    await logWorkflowEvent({ entityType: "cash", record, action: "dad_approved", from: "Reviewed", to: "PendingPCMEDReview", user: req.user });
    try {
      await notifyPcmedStep({
        record,
        actorId: req.user.id,
        entityType: "cash",
        event: "sent_to_pcmed",
        permission: "pcmed.review",
        message: `${req.user.name} approved a cash position record from ${record.organization} for PCMED review`,
      });
    } catch (notifyError) {
      console.error("Failed to notify PCMED reviewers:", notifyError);
    }

    try {
      await notifyOrganization({
        organization: record.organization,
        actorId: user.id,
        entityType: "cash",
        entityId: record.id,
        event: "approved",
        message: `${user.name} approved a cash position and sent it to PCMED`,
      });
    } catch (notifyError) {
      console.error("Failed to update cash approval notifications:", notifyError);
    }

    res.status(200).json({
      success: true,
      message: "Cash position approved and sent to PCMED for review",
      data: record,
    });
  } catch (error) {
    next(error);
  }
};

export const markCashViewed = async (req, res, next) => {
  try {
    const user = req.user;
    const record = await Cash.findByPk(req.params.id);
    if (!record) {
      const error = new Error("Cash position record not found");
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
      entityType: "cash",
      label: "cash position",
    });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};


// PATCH /:id/return — send back to the data entry officer for correction.
export const returnCashPosition = makeReturnHandler({
  Model: Cash,
  entityType: "cash",
  label: "Cash position",
});
