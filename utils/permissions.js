// Record permissions per role (System Management › Roles & Permissions › Permissions).
//
// Each role starts with the permissions it has always had; an administrator can turn
// them on or off per role. Administrators keep every permission so nobody can lock
// the system's administrators out. The record workflow still applies on top: a
// permission lets a role take a step, the workflow decides on which records
// (e.g. approval needs a reviewed record; returns follow the steps a role acts on).
import sequelize from "../config/database.js";
import { RoleAccessChange, RolePermission } from "../models/rolePageAccess.model.js";
import { ROLES } from "./pageAccess.js";

export const PERMISSIONS = [
  { key: "records.create", label: "Create records", action: "create records" },
  { key: "records.edit", label: "Edit or delete records", action: "edit or delete records" },
  { key: "records.review", label: "Review pending records", action: "review records" },
  { key: "records.approve", label: "Approve reviewed records", action: "approve records" },
  { key: "records.return", label: "Return records for correction", action: "return records" },
  { key: "records.exportApproved", label: "Export approved records", action: "export records" },
  { key: "records.exportAll", label: "Export records of any status", action: "export records" },
  {
    key: "records.viewUnapproved",
    label: "View records still in the approval workflow",
    action: "view records that are not yet approved",
  },
  // PCMED steps after DAD approval (kept separate from the DAD permissions).
  { key: "pcmed.review", label: "PCMED review (recommend for approval)", action: "review records for PCMED" },
  { key: "pcmed.return", label: "PCMED return", action: "return records as PCMED" },
  { key: "pcmed.approve", label: "PCMED final approval", action: "give final approval" },
  // Annual Cash Plan (prepared by the DAD and submitted as one plan).
  { key: "cashPlan.edit", label: "Prepare the annual cash plan", action: "change the cash plan" },
  { key: "cashPlan.submit", label: "Submit the annual cash plan for review", action: "submit the cash plan" },
  { key: "cashPlan.review", label: "Recommend cash plans for approval", action: "recommend the cash plan" },
  { key: "cashPlan.approve", label: "Approve cash plans and submit them to PCMED", action: "approve the cash plan" },
  { key: "cashPlan.return", label: "Return cash plans for correction", action: "return the cash plan" },
  { key: "cashPlan.reports", label: "Export cash plan reports", action: "export the cash plan" },
  // Work Plan (prepared by the DAD and submitted as one plan; same workflow as the cash plan).
  { key: "workPlan.edit", label: "Prepare the work plan", action: "change the work plan" },
  { key: "workPlan.submit", label: "Submit the work plan for review", action: "submit the work plan" },
  { key: "workPlan.review", label: "Recommend work plans for approval", action: "recommend the work plan" },
  { key: "workPlan.approve", label: "Approve work plans and submit them to PCMED", action: "approve the work plan" },
  { key: "workPlan.return", label: "Return work plans for correction", action: "return the work plan" },
  // Budget Ceilings (consolidated distribution; final approval by the Hon. Deputy Minister).
  { key: "ceilings.view", label: "View budget ceiling distributions", action: "view budget ceilings" },
  { key: "ceilings.prepare", label: "Prepare and submit the budget ceiling distribution", action: "prepare budget ceilings" },
  { key: "ceilings.recommend", label: "Recommend budget ceiling distributions", action: "recommend the ceiling distribution" },
  { key: "ceilings.endorse", label: "Endorse budget ceiling distributions", action: "endorse the ceiling distribution" },
  { key: "ceilings.approve", label: "Give final approval to budget ceiling distributions", action: "approve the ceiling distribution" },
  { key: "budget.mapActivities", label: "Assign activities to budget lines", action: "change budget line activity mappings" },
];

const DEFAULTS = {
  admin: PERMISSIONS.map((p) => p.key),
  data_entry: ["records.create", "records.edit", "records.exportApproved", "records.viewUnapproved", "cashPlan.edit", "cashPlan.submit", "cashPlan.reports", "workPlan.edit", "workPlan.submit"],
  reviewer: ["records.review", "records.return", "records.exportApproved", "records.exportAll", "records.viewUnapproved", "cashPlan.reports", "cashPlan.review", "cashPlan.return", "workPlan.review", "workPlan.return"],
  approver: ["records.approve", "records.return", "records.exportApproved", "records.exportAll", "records.viewUnapproved", "cashPlan.approve", "cashPlan.return", "cashPlan.reports", "workPlan.approve", "workPlan.return"],
  pcmed_reviewer: ["pcmed.review", "pcmed.return", "records.viewUnapproved", "cashPlan.reports", "budget.mapActivities", "ceilings.view", "ceilings.prepare"],
  pcmed_approver: ["pcmed.approve", "pcmed.return", "records.viewUnapproved", "cashPlan.reports", "budget.mapActivities", "ceilings.view", "ceilings.recommend"],
  // Executives: read-only oversight of PCMED-approved data. The Chief Director also
  // monitors submission progress, so sees records still in the workflow.
  minister: ["records.exportApproved", "ceilings.view"],
  deputy_minister: ["records.exportApproved", "ceilings.view", "ceilings.approve"],
  chief_director: ["records.exportApproved", "records.exportAll", "records.viewUnapproved", "ceilings.view", "ceilings.endorse"],
};

const KEYS = new Set(PERMISSIONS.map((p) => p.key));
const isLocked = (role) => role === "admin";
const label = (key) => PERMISSIONS.find((p) => p.key === key)?.label ?? key;

let cache = null;
async function overrides() {
  if (!cache) {
    const rows = await RolePermission.findAll({ attributes: ["role", "permission", "allowed"] });
    cache = {};
    rows.forEach((r) => {
      (cache[r.role] ??= {})[r.permission] = Boolean(r.allowed);
    });
  }
  return cache;
}

/** { permission: boolean } for one role. */
export async function permissionsForRole(role) {
  const defaults = new Set(DEFAULTS[role] || []);
  if (isLocked(role)) return Object.fromEntries(PERMISSIONS.map((p) => [p.key, true]));
  const saved = (await overrides())[role] || {};
  return Object.fromEntries(PERMISSIONS.map((p) => [p.key, saved[p.key] ?? defaults.has(p.key)]));
}

/** Permission definitions and every role's permissions. */
export async function permissionMatrix() {
  const roles = {};
  for (const role of ROLES) roles[role] = await permissionsForRole(role);
  return {
    definitions: PERMISSIONS.map(({ key, label: name }) => ({ key, label: name })),
    lockedRoles: ROLES.filter(isLocked),
    defaults: DEFAULTS,
    roles,
  };
}

/** Apply { permission: boolean } changes for one role and log each real change. */
export async function updateRolePermissions(role, changes, user) {
  const fail = (message) => Object.assign(new Error(message), { statusCode: 400 });
  if (!ROLES.includes(role)) throw fail("Unknown role");
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw fail("No changes given");
  const current = await permissionsForRole(role);
  const updates = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!KEYS.has(key)) throw fail(`Unknown permission: ${key}`);
    if (typeof value !== "boolean") throw fail(`${label(key)} must be true or false`);
    if (isLocked(role) && value !== current[key]) {
      throw fail("Administrators always keep every permission");
    }
    if (value !== current[key]) updates.push([key, value]);
  }
  if (updates.length) {
    await sequelize.transaction(async (transaction) => {
      for (const [permission, allowed] of updates) {
        const [row] = await RolePermission.findOrCreate({
          where: { role, permission },
          defaults: { allowed, updated_by: user.name },
          transaction,
        });
        if (row.allowed !== allowed) {
          row.allowed = allowed;
          row.updated_by = user.name;
          await row.save({ transaction });
        }
        await RoleAccessChange.create(
          { role, page: permission, kind: "permission", allowed, changed_by_id: user.id, changed_by: user.name },
          { transaction },
        );
      }
    });
    cache = null;
  }
  return permissionsForRole(role);
}

export const permissionLabel = label;

/**
 * Middleware: continue when the user's role has any of `keys`; otherwise 403.
 * Attaches req.user.permissions for the workflow checks that follow.
 * Use after protectRoutes.
 */
export const requirePermission = (...keys) => async (req, res, next) => {
  try {
    const permissions = await permissionsForRole(req.user?.role);
    req.user.permissions = permissions;
    if (keys.some((k) => permissions[k])) return next();
    const action = PERMISSIONS.find((p) => p.key === keys[0])?.action ?? "do this";
    return next(Object.assign(new Error(`Your role does not have permission to ${action}`), { statusCode: 403 }));
  } catch (error) {
    next(error);
  }
};

/** True when the user may see records that are not yet finally approved. */
export async function canViewUnapproved(user) {
  return Boolean((await permissionsForRole(user?.role))["records.viewUnapproved"]);
}

/**
 * Middleware for report and analytics routes: users who may only see approved data
 * get their status filters fixed to "Approved", whatever they ask for.
 */
export const approvedOnlyUnlessPermitted = async (req, res, next) => {
  try {
    if (await canViewUnapproved(req.user)) return next();
    const query = { ...req.query, status: "Approved", dataStatus: "Approved" };
    Object.defineProperty(req, "query", { value: query, writable: true, configurable: true, enumerable: true });
    next();
  } catch (error) {
    next(error);
  }
};
