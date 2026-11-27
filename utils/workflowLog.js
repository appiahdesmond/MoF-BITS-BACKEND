// Workflow audit trail: one row per step taken on a record (workflow_events).
import { WorkflowEvent } from "../models/workflow.model.js";

/**
 * Record a workflow step. Never throws: the step itself has already been saved,
 * so a logging failure is reported rather than undoing the user's action.
 */
export async function logWorkflowEvent({ entityType, record, action, from, to, comment, user }) {
  try {
    await WorkflowEvent.create({
      entity_type: entityType,
      entity_id: record.id,
      organization: record.organization ?? null,
      action,
      from_status: from ?? null,
      to_status: to ?? record.status ?? null,
      comment: comment || null,
      actor_id: user?.id ?? null,
      actor_name: user?.name ?? null,
      actor_role: user?.role ?? null,
    });
  } catch (error) {
    console.error(`Failed to log ${action} on ${entityType} ${record?.id}:`, error);
  }
}

/** A record's workflow history, oldest first. */
export async function workflowHistory(entityType, entityId) {
  const rows = await WorkflowEvent.findAll({
    where: { entity_type: entityType, entity_id: entityId },
    order: [["created_at", "ASC"], ["id", "ASC"]],
  });
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    from: r.from_status,
    to: r.to_status,
    comment: r.comment,
    actor: r.actor_name,
    actorRole: r.actor_role,
    at: r.createdAt,
  }));
}
