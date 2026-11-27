import { requirePage } from "../utils/pageAccess.js";
import { Router } from "express";
import { addExpenditure, approveExpenditure, deleteExpenditure, getAllExpenditure, markExpenditureViewed, reviewExpenditure, updateExpenditure, returnExpenditure } from "../controllers/expenditure.controller.js";
import { protectRoutes } from "../middleware/routesProtect.js";
import { requirePermission } from "../utils/permissions.js";


const router = Router();

router.use(protectRoutes);
// Only roles allowed to open this page (Console › Roles & Permissions).
router.use(requirePage("expenditure"));

router.post("/", requirePermission("records.create"), addExpenditure);

router.put("/:id", requirePermission("records.edit"), updateExpenditure);

router.delete("/:id", requirePermission("records.edit"), deleteExpenditure);

//reviewer
router.patch("/:id/review", requirePermission("records.review"), reviewExpenditure);
router.patch("/:id/return", requirePermission("records.return"), returnExpenditure);

//approver
router.patch("/:id/approve", requirePermission("records.approve"), approveExpenditure);

router.post("/:id/view", requirePermission("records.review", "records.approve"), markExpenditureViewed);

router.get("/", getAllExpenditure);

export default router;