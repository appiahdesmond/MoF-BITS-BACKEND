// "Return for correction": shared handler for revenue, cash, expenditure and reallocation.
import { workflowStepError } from "./workflowGuard.js";
import { notifyOrganization } from "./notify.js";

const MAX_REASON = 1000;

/**
 * PATCH /:id/return  { reason }
 * Moves a Pending (reviewer) or Reviewed (approver) record to Returned with a reason,
 * and notifies the organisation so the data entry officer can correct and resubmit it.
 */
export function makeReturnHandler({ Model, entityType, label }) {
  return async (req, res, next) => {
    try {
      const user = req.user;
      const reason = String(req.body?.reason ?? "").trim();
      if (!reason) {
        return next(Object.assign(new Error("Please give a reason for returning this record"), { statusCode: 400 }));
      }
      if (reason.length > MAX_REASON) {
        return next(
          Object.assign(new Error(`The reason must be ${MAX_REASON} characters or fewer`), { statusCode: 400 }),
        );
      }

      const record = await Model.findByPk(req.params.id);
      if (!record) {
        return next(Object.assign(new Error(`${label} record not found`), { statusCode: 404 }));
      }

      const stepError = workflowStepError(record, user, "return");
      if (stepError) return next(stepError);

      record.status = "Returned";
      record.returnReason = reason;
      record.returnedBy = user.name;
      record.returnedAt = new Date();
      await record.save();

      try {
        await notifyOrganization({
          organization: record.organization,
          actorId: user.id,
          entityType,
          entityId: record.id,
          event: "returned",
          message: `${user.name} returned a ${label.toLowerCase()} record for correction`,
        });
      } catch (notifyError) {
        console.error(`Failed to send ${entityType} return notification:`, notifyError);
      }

      res.status(200).json({
        success: true,
        message: `${label} record returned for correction`,
        data: record,
      });
    } catch (error) {
      next(error);
    }
  };
}

/** Notify the organisation that a returned record was corrected and resubmitted. */
export async function notifyResubmitted({ record, user, entityType, label }) {
  try {
    await notifyOrganization({
      organization: record.organization,
      actorId: user.id,
      entityType,
      entityId: record.id,
      event: "resubmitted",
      message: `${user.name} corrected and resubmitted a ${label.toLowerCase()} record`,
    });
  } catch (notifyError) {
    console.error(`Failed to send ${entityType} resubmission notification:`, notifyError);
  }
}
