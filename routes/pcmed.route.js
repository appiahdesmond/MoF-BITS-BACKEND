// PCMED workbenches: review and final approval of DAD-approved records.
import { Router } from "express";
import { protectRoutes } from "../middleware/routesProtect.js";
import { requirePermission } from "../utils/permissions.js";
import {
  approveRecord,
  getCounts,
  getQueue,
  getRecord,
  getSummary,
  returnRecord,
  reviewRecord,
} from "../controllers/pcmed.controller.js";

const router = Router();
router.use(protectRoutes);

router.get("/counts", requirePermission("pcmed.review", "pcmed.approve"), getCounts);
router.get("/summary", requirePermission("pcmed.review", "pcmed.approve"), getSummary);
router.get("/queue", requirePermission("pcmed.review", "pcmed.approve"), getQueue);
router.get("/:type/:id", requirePermission("pcmed.review", "pcmed.approve"), getRecord);
router.patch("/:type/:id/review", requirePermission("pcmed.review"), reviewRecord);
router.patch("/:type/:id/approve", requirePermission("pcmed.approve"), approveRecord);
router.patch("/:type/:id/return", requirePermission("pcmed.return"), returnRecord);

export default router;
