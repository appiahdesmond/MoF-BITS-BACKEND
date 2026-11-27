// Console › Roles & Permissions.
import { Router } from "express";
import { protectRoutes } from "../middleware/routesProtect.js";
import { restrict } from "../middleware/restrict.js";
import {
  accessForRole,
  accessHistory,
  accessMatrix,
  landingForRole,
  ROLES,
  setLandingForRole,
  updateRoleAccess,
} from "../utils/pageAccess.js";
import {
  permissionLabel,
  permissionMatrix,
  permissionsForRole,
  updateRolePermissions,
} from "../utils/permissions.js";

const router = Router();
router.use(protectRoutes);

/** GET /api/roles/my-access — the pages the signed-in user's role can open. */
router.get("/my-access", async (req, res, next) => {
  try {
    res.json({
      success: true,
      role: req.user.role,
      access: await accessForRole(req.user.role),
      permissions: await permissionsForRole(req.user.role),
      landing: await landingForRole(req.user.role),
      dataScope: req.user.role === "admin" ? "all" : req.user.data_scope,
    });
  } catch (error) {
    next(error);
  }
});

/** GET /api/roles/page-access — page access for every role (administrators). */
router.get("/page-access", restrict("admin"), async (req, res, next) => {
  try {
    res.json({ success: true, ...(await accessMatrix()), permissions: await permissionMatrix() });
  } catch (error) {
    next(error);
  }
});

/** PUT /api/roles/:role/page-access  { changes: { page: boolean } } */
router.put("/:role/page-access", restrict("admin"), async (req, res, next) => {
  try {
    const access = await updateRoleAccess(req.params.role, req.body?.changes, req.user);
    res.json({ success: true, message: "Page access updated", access });
  } catch (error) {
    next(error);
  }
});

/** PUT /api/roles/:role/landing  { page } — the page the role opens after signing in. */
router.put("/:role/landing", restrict("admin"), async (req, res, next) => {
  try {
    const landing = await setLandingForRole(req.params.role, String(req.body?.page ?? ""), req.user);
    res.json({ success: true, message: "Landing page updated", landing });
  } catch (error) {
    next(error);
  }
});

/** PUT /api/roles/:role/permissions  { changes: { permission: boolean } } */
router.put("/:role/permissions", restrict("admin"), async (req, res, next) => {
  try {
    const permissions = await updateRolePermissions(req.params.role, req.body?.changes, req.user);
    res.json({ success: true, message: "Permissions updated", permissions });
  } catch (error) {
    next(error);
  }
});

/** GET /api/roles/:role/history — page access changes for one role, newest first. */
router.get("/:role/history", restrict("admin"), async (req, res, next) => {
  try {
    if (!ROLES.includes(req.params.role)) {
      return next(Object.assign(new Error("Unknown role"), { statusCode: 400 }));
    }
    const history = (await accessHistory(req.params.role)).map((row) =>
      row.kind === "permission" ? { ...row, pageLabel: permissionLabel(row.page) } : row,
    );
    // Landing page changes read "Default landing page: <page>".
    res.json({ success: true, history });
  } catch (error) {
    next(error);
  }
});

export default router;
