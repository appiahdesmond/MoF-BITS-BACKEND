// Enforces the record workflow on the server: Pending -> Reviewed -> Approved.
// The frontend hides buttons that don't apply, but the API must not rely on that.

const STEPS = {
  review: { from: "Pending", verb: "reviewed" },
  approve: { from: "Reviewed", verb: "approved" },
};

/**
 * Returns an Error (with statusCode) if `user` may not take `step` on `record`,
 * otherwise null.
 *  - Non-admins can only act on records from their own organisation.
 *  - review requires status Pending; approve requires status Reviewed.
 */
export function workflowStepError(record, user, step) {
  const rule = STEPS[step];
  const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

  if (user.role !== "admin" && record.organization !== user.organization) {
    return fail(403, `You can only ${step} records from your own organization`);
  }
  if (record.status === "Approved") {
    return fail(409, "This record has already been approved");
  }
  if (record.status !== rule.from) {
    return fail(
      409,
      step === "approve"
        ? "Only reviewed records can be approved. Send it for review first."
        : "Only pending records can be reviewed",
    );
  }
  return null;
}
