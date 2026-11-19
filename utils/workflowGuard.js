// Enforces the record workflow on the server:
//
//   Pending --review--> Reviewed --approve--> Approved
//      |                    |
//      +----return----------+--> Returned --edit (resubmit)--> Pending
//
// The frontend hides actions that don't apply, but the API must not rely on that.

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

const isAdmin = (user) => user.role === "admin";

/**
 * Returns an Error (with statusCode) if `user` may not take `step` on `record`,
 * otherwise null. Steps: "review", "approve", "return".
 *  - Non-admins can only act on records from their own organisation.
 *  - review: Pending only. approve: Reviewed only.
 *  - return: a reviewer returns Pending records, an approver returns Reviewed
 *    records; an admin may return either.
 */
export function workflowStepError(record, user, step) {
  if (!isAdmin(user) && record.organization !== user.organization) {
    return fail(403, `You can only ${step} records from your own organization`);
  }
  if (record.status === "Approved") {
    return fail(409, "This record has already been approved");
  }
  if (record.status === "Returned") {
    return fail(409, "This record has been returned for correction and is waiting on the data entry officer");
  }

  if (step === "review" && record.status !== "Pending") {
    return fail(409, "Only pending records can be reviewed");
  }
  if (step === "approve" && record.status !== "Reviewed") {
    return fail(409, "Only reviewed records can be approved. Send it for review first.");
  }
  if (step === "return") {
    const allowed = isAdmin(user)
      ? ["Pending", "Reviewed"]
      : user.role === "reviewer"
        ? ["Pending"]
        : user.role === "approver"
          ? ["Reviewed"]
          : [];
    if (!allowed.includes(record.status)) {
      return fail(
        409,
        user.role === "approver"
          ? "Approvers can only return records that have been reviewed"
          : "Reviewers can only return records that are pending review",
      );
    }
  }
  return null;
}

/**
 * Returns an Error if `user` may not edit or delete `record`, otherwise null.
 * Call after the creator-or-admin ownership check.
 *  - Data entry officers change records only after they are returned for correction.
 *  - Admins may also change Pending records.
 *  - Nobody changes Reviewed or Approved records.
 */
export function editStepError(record, user, verb = "edit") {
  if (record.status === "Reviewed" || record.status === "Approved") {
    return fail(400, `You cannot ${verb} a reviewed or approved record`);
  }
  if (record.status === "Pending" && !isAdmin(user)) {
    return fail(
      409,
      `This record is waiting for review. You can ${verb} it if it is returned for correction.`,
    );
  }
  return null;
}
