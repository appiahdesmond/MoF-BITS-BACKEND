// Console › Roles & Permissions.
import { Router } from "express";
import { protectRoutes } from "../middleware/routesProtect.js";
import { restrict } from "../middleware/restrict.js";
import { accessForRole, accessHistory, accessMatrix, ROLES, updateRoleAccess } from "../utils/pageAccess.js";

const router = Router();
router.use(protectRoutes);

/** GET /api/roles/my-access — the pages the signed-in user's role can open. */
router.get("/my-access", async (req, res, next) => {
  try {
    res.json({ success: true, role: req.user.role, access: await accessForRole(req.user.role) });
  } catch (error) {
    next(error);
  }
});

/** GET /api/roles/page-access — page access for every role (administrators). */
router.get("/page-access", restrict("admin"), async (req, res, next) => {
  try {
    res.json({ success: true, ...(await accessMatrix()) });
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

/** GET /api/roles/:role/history — page access changes for one role, newest first. */
router.get("/:role/history", restrict("admin"), async (req, res, next) => {
  try {
    if (!ROLES.includes(req.params.role)) {
      return next(Object.assign(new Error("Unknown role"), { statusCode: 400 }));
    }
    res.json({ success: true, history: await accessHistory(req.params.role) });
  } catch (error) {
    next(error);
  }
});

export default router;
