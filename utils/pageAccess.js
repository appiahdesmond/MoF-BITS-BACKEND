// Page access per role (Console › Roles & Permissions › Page Access).
//
// Every page is open to every role unless an administrator turns it off for a role.
// Locked pages cannot be changed: Console is for administrators only, Settings (own
// account and password) is always available, and administrators keep every page so
// nobody can lock the system's administrators out.
import sequelize from "../config/database.js";
import { RoleAccessChange, RolePageAccess } from "../models/rolePageAccess.model.js";

export const ROLES = ["admin", "data_entry", "reviewer", "approver"];

export const PAGES = [
  { key: "dashboard", label: "Executive Financial Dashboard" },
  { key: "expenditureAnalysis", label: "Expenditure Analysis" },
  { key: "igfAnalysis", label: "IGF Collection Analysis" },
  { key: "revenue", label: "IGF Revenue Collection" },
  { key: "cash", label: "Cash Position" },
  { key: "expenditure", label: "DADs Expenditure" },
  { key: "reallocation", label: "Reallocation" },
  { key: "reports", label: "Reports" },
  { key: "console", label: "System Management", locked: true },
  { key: "settings", label: "Settings", locked: true },
];

const PAGE_KEYS = new Set(PAGES.map((p) => p.key));
const isLocked = (role, page) => role === "admin" || PAGES.find((p) => p.key === page)?.locked;
const lockedValue = (role, page) => (page === "console" ? role === "admin" : true);

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
    PAGES.map(({ key }) => [key, isLocked(role, key) ? lockedValue(role, key) : (saved[key] ?? true)]),
  );
}

/** Page access for every role, with which entries are locked. */
export async function accessMatrix() {
  const roles = {};
  for (const role of ROLES) roles[role] = await accessForRole(role);
  return {
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
