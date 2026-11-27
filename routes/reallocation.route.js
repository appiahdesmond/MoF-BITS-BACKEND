import { requirePage } from "../utils/pageAccess.js";
import { Router } from "express";
import { requirePermission } from "../utils/permissions.js";
import { protectRoutes } from "../middleware/routesProtect.js";
import { addReallocation, approveReallocation, deleteReallocation, getAllReallocation, markReallocationViewed, reviewReallocation, updateReallocation, returnReallocation } from "../controllers/reallocation.controller.js";

const router = Router();

router.use(protectRoutes);
// Only roles allowed to open this page (Console › Roles & Permissions).
router.use(requirePage("reallocation"));

router.post("/", requirePermission("records.create"), addReallocation);

router.put("/:id", requirePermission("records.edit"), updateReallocation);

router.delete("/:id", requirePermission("records.edit"), deleteReallocation);

//reviewer
router.patch("/:id/review", requirePermission("records.review"), reviewReallocation);
router.patch("/:id/return", requirePermission("records.return"), returnReallocation);

//approver
router.patch("/:id/approve", requirePermission("records.approve"), approveReallocation);

router.post("/:id/view", requirePermission("records.review", "records.approve"), markReallocationViewed);

router.get("/", getAllReallocation);

export default router;