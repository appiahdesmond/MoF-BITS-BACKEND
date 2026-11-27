import { requirePage } from "../utils/pageAccess.js";
import { Router } from "express";
import { requirePermission } from "../utils/permissions.js";
import { protectRoutes } from "../middleware/routesProtect.js";
import { addRevenue, approveRevenue, deleteRevenue, getAllRevenue, markRevenueViewed, reviewRevenue, updateRevenue, returnRevenue } from "../controllers/revenue.controller.js";

const router = Router();

router.use(protectRoutes);
// Only roles allowed to open this page (Console › Roles & Permissions).
router.use(requirePage("revenue"));

router.post("/", requirePermission("records.create"), addRevenue);

router.put("/:id", requirePermission("records.edit"), updateRevenue);

router.delete("/:id", requirePermission("records.edit"), deleteRevenue);

//reviewer
router.patch("/:id/review", requirePermission("records.review"), reviewRevenue);
router.patch("/:id/return", requirePermission("records.return"), returnRevenue);

//approver
router.patch("/:id/approve", requirePermission("records.approve"), approveRevenue);

router.post("/:id/view", requirePermission("records.review", "records.approve"), markRevenueViewed);

router.get("/", getAllRevenue);

export default router;