import { Router } from "express";
import { restrict } from "../middleware/restrict.js";
import { protectRoutes } from "../middleware/routesProtect.js";
import { addReallocation, approveReallocation, deleteReallocation, getAllReallocation, markReallocationViewed, reviewReallocation, updateReallocation, returnReallocation } from "../controllers/reallocation.controller.js";

const router = Router();

router.use(protectRoutes);

router.post("/", restrict("data_entry", "admin"), addReallocation);

router.put("/:id", restrict("data_entry", "admin"), updateReallocation);

router.delete("/:id", restrict("data_entry", "admin"), deleteReallocation);

//reviewer
router.patch("/:id/review", restrict("reviewer", "admin"), reviewReallocation);
router.patch("/:id/return", restrict("reviewer", "approver", "admin"), returnReallocation);

//approver
router.patch("/:id/approve", restrict("approver", "admin"), approveReallocation);

router.post("/:id/view", restrict("reviewer", "approver", "admin"), markReallocationViewed);

router.get("/", getAllReallocation);

export default router;