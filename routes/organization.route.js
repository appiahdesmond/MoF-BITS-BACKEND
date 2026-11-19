import { Router } from "express";
import {
  createOrganization,
  deleteOrganization,
  listOrganizations,
  listRetentionRateChanges,
  updateOrganization,
  updateRetentionRate,
} from "../controllers/organization.controller.js";
import { protectRoutes } from "../middleware/routesProtect.js";
import { restrict } from "../middleware/restrict.js";

const router = Router();

// Any logged-in user can read the list (it feeds dropdowns across the app).
router.get("/", protectRoutes, listOrganizations);

router.get(
  "/retention-rate-changes",
  protectRoutes,
  restrict("admin"),
  listRetentionRateChanges,
);
router.post("/", protectRoutes, restrict("admin"), createOrganization);
router.put("/:id", protectRoutes, restrict("admin"), updateOrganization);
router.delete("/:id", protectRoutes, restrict("admin"), deleteOrganization);
router.put(
  "/:id/retention-rate",
  protectRoutes,
  restrict("admin"),
  updateRetentionRate,
);

export default router;
