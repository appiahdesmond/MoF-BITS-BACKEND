import { Router } from "express";
import { restrict } from "../middleware/restrict.js";
import { protectRoutes } from "../middleware/routesProtect.js";
import { addCashPosition, approveCashPosition, deleteCashPosition, getAllCashPositions, markCashViewed, reviewCashPosition, updateCashPosition } from "../controllers/cash.controller.js";

const router = Router();

// every request must have a token or user must be logged in.
router.use(protectRoutes);

router.post("/", restrict("data_entry", "admin"), addCashPosition);

router.put("/:id", restrict("data_entry", "admin"), updateCashPosition);

router.delete("/:id", restrict("data_entry", "admin"), deleteCashPosition);

//reviewer
router.patch("/:id/review", restrict("reviewer", "admin"), reviewCashPosition);

//approver
router.patch("/:id/approve", restrict("approver", "admin"), approveCashPosition);

router.post("/:id/view", restrict("reviewer", "approver", "admin"), markCashViewed);

router.get("/", getAllCashPositions);

export default router;