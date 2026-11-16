import { Op } from "sequelize";
import User from "../models/users.js";
import Notification from "../models/notification.model.js";

function describeForAdmin({ message, actorName, actorOrganization, recordOrganization }) {
  const name = actorName || "A user";
  const org = actorOrganization || recordOrganization || "their organization";
  const prefix = `${name} `;
  let action = message.startsWith(prefix) ? message.slice(prefix.length) : message;

  if (
    recordOrganization &&
    actorOrganization &&
    recordOrganization !== actorOrganization &&
    !action.includes(recordOrganization)
  ) {
    action = `${action} in ${recordOrganization}`;
  }

  return `${name} from ${org} ${action}`;
}

export async function notifyOrganization({
  organization,
  actorId,
  entityType,
  entityId,
  event,
  message,
}) {
  const actor = actorId
    ? await User.findByPk(actorId, {
        attributes: ["id", "name", "organization"],
      })
    : null;

  const [recipients, admins] = await Promise.all([
    User.findAll({
      where: {
        organization,
        status: "active",
        role: { [Op.ne]: "admin" },
        ...(actorId ? { id: { [Op.ne]: actorId } } : {}),
      },
      attributes: ["id"],
    }),
    User.findAll({
      where: {
        role: "admin",
        status: "active",
        ...(actorId ? { id: { [Op.ne]: actorId } } : {}),
      },
      attributes: ["id"],
    }),
  ]);

  const adminMessage = describeForAdmin({
    message,
    actorName: actor?.name,
    actorOrganization: actor?.organization,
    recordOrganization: organization,
  });

  const rows = [
    ...recipients.map((recipient) => ({
      userId: recipient.id,
      organization,
      actorId,
      entityType,
      entityId,
      event,
      message,
    })),
    ...admins.map((admin) => ({
      userId: admin.id,
      organization,
      actorId,
      entityType,
      entityId,
      event,
      message: adminMessage,
    })),
  ];

  if (!rows.length) return;

  await Notification.bulkCreate(rows);
}

export async function notifyRecordOpened({ actor, record, entityType, label }) {
  const submitterId = record.user_id ?? record.userId;
  if (!actor || !submitterId || submitterId === actor.id) return;

  const openedPending =
    record.status === "Pending" &&
    (actor.role === "reviewer" || actor.role === "admin");
  const openedReviewed =
    record.status === "Reviewed" &&
    (actor.role === "approver" || actor.role === "admin");

  if (!openedPending && !openedReviewed) return;

  const action = openedPending ? "reviewed" : "approved";

  await Notification.findOrCreate({
    where: {
      userId: submitterId,
      actorId: actor.id,
      entityType,
      entityId: record.id,
      event: "viewed",
    },
    defaults: {
      organization: record.organization,
      message: `${actor.name} opened a ${label} and has not ${action} it`,
    },
  });
}
