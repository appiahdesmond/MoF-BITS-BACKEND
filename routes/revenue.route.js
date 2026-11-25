import { requirePage } from "../utils/pageAccess.js";
import { Router } from "express";
import { restrict } from "../middleware/restrict.js";
import { protectRoutes } from "../middleware/routesProtect.js";
import { addRevenue, approveRevenue, deleteRevenue, getAllRevenue, markRevenueViewed, reviewRevenue, updateRevenue, returnRevenue } from "../controllers/revenue.controller.js";

const router = Router();

router.use(protectRoutes);
// Only roles allowed to open this page (Console › Roles & Permissions).
router.use(requirePage("revenue"));

router.post("/", restrict("data_entry", "admin"), addRevenue);

router.put("/:id", restrict("data_entry", "admin"), updateRevenue);

router.delete("/:id", restrict("data_entry", "admin"), deleteRevenue);

//reviewer
router.patch("/:id/review", restrict("reviewer", "admin"), reviewRevenue);
router.patch("/:id/return", restrict("reviewer", "approver", "admin"), returnRevenue);

//approver
router.patch("/:id/approve", restrict("approver", "admin"), approveRevenue);

router.post("/:id/view", restrict("reviewer", "approver", "admin"), markRevenueViewed);

router.get("/", getAllRevenue);

export default router;