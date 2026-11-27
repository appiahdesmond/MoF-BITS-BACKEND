import { Router } from "express";
import { protectRoutes } from "../middleware/routesProtect.js";
import { requirePage } from "../utils/pageAccess.js";
import { requirePermission } from "../utils/permissions.js";
import {
  exportCashPlan,
  getApproved,
  getCashPlan,
  getHistory,
  getUnmapped,
  patchBudgetLineActivity,
  postReturn,
  postStep,
  putAllocations,
  putJustification,
} from "../controllers/cashPlan.controller.js";

// Annual Cash Plan. Every route checks the page, then the permission for the step;
// the service checks the DAD against the user's data scope.
const router = Router();
router.use(protectRoutes, requirePage("cashPlan"));

router.get("/", getCashPlan); // ?year=&organization= (organization only for users who see several DADs)
router.get("/approved", getApproved); // approved monthly requirements, for allotment preparation
// Budget lines without an Activity/Operation code, and assigning one (authorised PCMED officers).
router.get("/unmapped", requirePermission("budget.mapActivities"), getUnmapped);
router.patch("/budget-lines/:id/activity", requirePermission("budget.mapActivities"), patchBudgetLineActivity);
router.get("/:id/history", getHistory);
router.get("/:id/export", requirePermission("cashPlan.reports"), exportCashPlan);
router.put("/:id/allocations", requirePermission("cashPlan.edit"), putAllocations);
router.put("/:id/lines/:lineId/justification", requirePermission("cashPlan.edit"), putJustification);
// Workflow (the service re-checks the step's permission, the DAD scope and segregation of duties).
router.post("/:id/submit", requirePermission("cashPlan.submit"), postStep("submit")); // Data Entry: Submit for Review
router.post("/:id/recommend", requirePermission("cashPlan.review"), postStep("recommend")); // DAD Reviewer
router.post("/:id/approve", requirePermission("cashPlan.approve"), postStep("approve")); // DAD Approver: Approve & Submit
router.post("/:id/start-verification", requirePermission("pcmed.review"), postStep("startVerification")); // PCMED
router.post("/:id/verify", requirePermission("pcmed.approve"), postStep("verify")); // PCMED
router.post("/:id/return", requirePermission("cashPlan.return", "pcmed.return"), postReturn);

export default router;
