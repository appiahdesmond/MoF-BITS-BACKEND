import { requirePage } from "../utils/pageAccess.js";
import { Router } from "express";
import { requirePermission } from "../utils/permissions.js";
import { protectRoutes } from "../middleware/routesProtect.js";
import { addCashPosition, approveCashPosition, deleteCashPosition, getAllCashPositions, markCashViewed, reviewCashPosition, updateCashPosition, returnCashPosition } from "../controllers/cash.controller.js";

const router = Router();

// every request must have a token or user must be logged in.
router.use(protectRoutes);
// Only roles allowed to open this page (Console › Roles & Permissions).
router.use(requirePage("cash"));

router.post("/", requirePermission("records.create"), addCashPosition);

router.put("/:id", requirePermission("records.edit"), updateCashPosition);

router.delete("/:id", requirePermission("records.edit"), deleteCashPosition);

//reviewer
router.patch("/:id/review", requirePermission("records.review"), reviewCashPosition);
router.patch("/:id/return", requirePermission("records.return"), returnCashPosition);

//approver
router.patch("/:id/approve", requirePermission("records.approve"), approveCashPosition);

router.post("/:id/view", requirePermission("records.review", "records.approve"), markCashViewed);

router.get("/", getAllCashPositions);

export default router;