// Page access per role (Console › Roles & Permissions › Page Access).
//
// Each role starts with its default pages (DAD roles: everything except the PCMED
// workbenches; PCMED roles: every page, including both workbenches) and an
// administrator can change them.
// Locked pages cannot be changed: Console is for administrators only, Settings (own
// account and password) is always available, and administrators keep every page so
// nobody can lock the system's administrators out.
import sequelize from "../config/database.js";
import { RoleAccessChange, RolePageAccess, RoleSetting } from "../models/rolePageAccess.model.js";

export const ROLES = [
  "admin",
  "data_entry",
  "reviewer",
  "approver",
  "pcmed_reviewer",
  "pcmed_approver",
  "minister",
  "deputy_minister",
  "chief_director",
];

export const EXECUTIVE_ROLES = new Set(["minister", "deputy_minister", "chief_director"]);

const DAD_ROLES = new Set(["data_entry", "reviewer", "approver"]);

export const PAGES = [
  { key: "dashboard", label: "Executive Financial Dashboard" },
  { key: "expenditureAnalysis", label: "Expenditure Analysis" },
  { key: "igfAnalysis", label: "IGF Collection Analysis" },
  { key: "revenue", label: "IGF Revenue Collection" },
  { key: "cash", label: "Cash Position" },
  { key: "expenditure", label: "DADs Expenditure" },
  { key: "reallocation", label: "Reallocation" },
  { key: "reports", label: "Reports" },
  { key: "pcmedReview", label: "Review Workbench" },
  { key: "pcmedApproval", label: "Approval Workbench" },
  { key: "compliance", label: "Reporting Compliance" },
  { key: "cashPlan", label: "Cash Plan" },
  { key: "workPlan", label: "Work Plan" },
  { key: "budgetCeilings", label: "Budget Ceilings" },
  { key: "console", label: "System Management", locked: true },
  { key: "settings", label: "Settings", locked: true },
];

const PAGE_KEYS = new Set(PAGES.map((p) => p.key));
const isLocked = (role, page) => role === "admin" || PAGES.find((p) => p.key === page)?.locked;
const lockedValue = (role, page) => (page === "console" ? role === "admin" : true);

const PCMED_ROLES = new Set(["pcmed_reviewer", "pcmed_approver"]);

/** A role's page before any administrator change. */
function defaultAccess(role, page) {
  // Each PCMED role works from its own workbench (reviewer: Review, approver: Approval).
  if (page === "pcmedReview") return role === "pcmed_reviewer";
  if (page === "pcmedApproval") return role === "pcmed_approver";
  // Reporting Compliance: PCMED, and the Chief Director who monitors compliance.
  if (page === "compliance") return PCMED_ROLES.has(role) || role === "chief_director";
  // Cash Plan: prepared by DADs, reviewed by PCMED.
  if (page === "cashPlan") return DAD_ROLES.has(role) || PCMED_ROLES.has(role);
  if (page === "workPlan") return DAD_ROLES.has(role) || PCMED_ROLES.has(role);
  if (page === "budgetCeilings") return DAD_ROLES.has(role) || PCMED_ROLES.has(role) || EXECUTIVE_ROLES.has(role);
  // Dashboards, analysis, registers and reports.
  return DAD_ROLES.has(role) || EXECUTIVE_ROLES.has(role) || PCMED_ROLES.has(role);
}

/** Default page each role opens on after signing in (administrators can change it). */
export const LANDING = {
  pcmed_reviewer: "pcmedReview",
  pcmed_approver: "pcmedApproval",
};

/** The landing page configured for a role (or its default), as a page key. */
export async function landingForRole(role) {
  const row = await RoleSetting.findByPk(role);
  return row?.landing_page || LANDING[role] || "dashboard";
}

/** Set a role's landing page; it must be a page the role may open. */
export async function setLandingForRole(role, page, user) {
  const fail = (message) => Object.assign(new Error(message), { statusCode: 400 });
  if (!ROLES.includes(role)) throw fail("Unknown role");
  if (!PAGE_KEYS.has(page)) throw fail("Unknown page");
  const access = await accessForRole(role);
  if (!access[page]) throw fail("The landing page must be a page this role can open");
  const before = await landingForRole(role);
  await RoleSetting.upsert({ role, landing_page: page, updated_by: user.name });
  if (before !== page) {
    await RoleAccessChange.create({
      role,
      page,
      kind: "landing",
      allowed: true,
      changed_by_id: user.id,
      changed_by: user.name,
    });
  }
  return page;
}

// Small in-memory cache: access is read on every guarded request.
let cache = null;

async function overrides() {
  if (!cache) {
    const rows = await RolePageAccess.findAll({ attributes: ["role", "page", "allowed"] });
    cache = {};
    rows.forEach((r) => {
      (cache[r.role] ??= {})[r.page] = Boolean(r.allowed);
    });
  }
  return cache;
}

/** { page: boolean } for one role. */
export async function accessForRole(role) {
  const saved = (await overrides())[role] || {};
  return Object.fromEntries(
    PAGES.map(({ key }) => [
      key,
      isLocked(role, key) ? lockedValue(role, key) : (saved[key] ?? defaultAccess(role, key)),
    ]),
  );
}

/** Page access for every role, with which entries are locked. */
export async function accessMatrix() {
  const roles = {};
  const landing = {};
  for (const role of ROLES) {
    roles[role] = await accessForRole(role);
    landing[role] = await landingForRole(role);
  }
  return {
    landing,
    pages: PAGES.map(({ key, label }) => ({
      key,
      label,
      lockedFor: ROLES.filter((role) => isLocked(role, key)),
    })),
    roles,
  };
}

/**
 * Apply changes for one role ({ page: boolean }) and log each real change.
 * Returns the role's new access. Throws (statusCode 400) on invalid input.
 */
export async function updateRoleAccess(role, changes, user) {
  const fail = (message) => Object.assign(new Error(message), { statusCode: 400 });
  if (!ROLES.includes(role)) throw fail("Unknown role");
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw fail("No changes given");

  const current = await accessForRole(role);
  const updates = [];
  for (const [page, value] of Object.entries(changes)) {
    if (!PAGE_KEYS.has(page)) throw fail(`Unknown page: ${page}`);
    if (typeof value !== "boolean") throw fail(`Access for ${page} must be true or false`);
    if (isLocked(role, page)) {
      if (value !== current[page]) {
        throw fail(
          role === "admin"
            ? "Administrators always keep access to every page"
            : `Access to ${PAGES.find((p) => p.key === page).label} cannot be changed`,
        );
      }
      continue;
    }
    if (value !== current[page]) updates.push([page, value]);
  }

  if (updates.length) {
    await sequelize.transaction(async (transaction) => {
      for (const [page, allowed] of updates) {
        const [row] = await RolePageAccess.findOrCreate({
          where: { role, page },
          defaults: { allowed, updated_by: user.name },
          transaction,
        });
        if (row.allowed !== allowed) {
          row.allowed = allowed;
          row.updated_by = user.name;
          await row.save({ transaction });
        }
        await RoleAccessChange.create(
          { role, page, allowed, changed_by_id: user.id, changed_by: user.name },
          { transaction },
        );
      }
    });
    cache = null;
  }
  return accessForRole(role);
}

/** Audit history for one role, newest first. */
export async function accessHistory(role, limit = 200) {
  const rows = await RoleAccessChange.findAll({
    where: { role },
    order: [["created_at", "DESC"], ["id", "DESC"]],
    limit,
  });
  return rows.map((r) => ({
    id: r.id,
    page: r.page,
    kind: r.kind || "page",
    pageLabel: PAGES.find((p) => p.key === r.page)?.label ?? r.page,
    allowed: Boolean(r.allowed),
    changedBy: r.changed_by,
    at: r.createdAt,
  }));
}

/**
 * Middleware: refuse the request when the signed-in user's role may not open `page`.
 * Use after protectRoutes.
 */
export const requirePage = (page) => async (req, res, next) => {
  try {
    const role = req.user?.role;
    if (role === "admin") return next();
    const access = await accessForRole(role);
    if (access[page]) return next();
    const label = PAGES.find((p) => p.key === page)?.label ?? page;
    return next(
      Object.assign(new Error(`Your role does not have access to ${label}`), { statusCode: 403 }),
    );
  } catch (error) {
    next(error);
  }
};
