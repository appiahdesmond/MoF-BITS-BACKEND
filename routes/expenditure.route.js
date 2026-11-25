import { requirePage } from "../utils/pageAccess.js";
import { Router } from "express";
import { addExpenditure, approveExpenditure, deleteExpenditure, getAllExpenditure, markExpenditureViewed, reviewExpenditure, updateExpenditure, returnExpenditure } from "../controllers/expenditure.controller.js";
import { protectRoutes } from "../middleware/routesProtect.js";
import { restrict } from "../middleware/restrict.js";


const router = Router();

router.use(protectRoutes);
// Only roles allowed to open this page (Console › Roles & Permissions).
router.use(requirePage("expenditure"));

router.post("/", restrict("data_entry", "admin"), addExpenditure);

router.put("/:id", restrict("data_entry", "admin"), updateExpenditure);

router.delete("/:id", restrict("data_entry", "admin"), deleteExpenditure);

//reviewer
router.patch("/:id/review", restrict("reviewer", "admin"), reviewExpenditure);
router.patch("/:id/return", restrict("reviewer", "approver", "admin"), returnExpenditure);

//approver
router.patch("/:id/approve", restrict("approver", "admin"), approveExpenditure);

router.post("/:id/view", restrict("reviewer", "approver", "admin"), markExpenditureViewed);

router.get("/", getAllExpenditure);

export default router;