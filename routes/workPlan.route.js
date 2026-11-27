import { Router } from "express";
import { protectRoutes } from "../middleware/routesProtect.js";
import { requirePage } from "../utils/pageAccess.js";
import { requirePermission } from "../utils/permissions.js";
import * as c from "../controllers/workPlan.controller.js";

// Work Plan. Every route checks the page, then the permission; the service checks the DAD
// scope, that the plan is editable and the revision the client saw.
const router = Router();
router.use(protectRoutes, requirePage("workPlan"));

router.get("/reference", c.getReference); // ?year= natural accounts, objectives, funding sources, costing methods
router.get("/", c.getWorkPlan); // ?year=&organization=
router.get("/awaiting-pcmed", c.getAwaitingPcmed); // for the PCMED Review Workbench
router.get("/verified", c.getVerified); // ?year=&organization= verified records for downstream planning
router.get("/:id/history", c.getHistory);
router.get("/:id/compare", c.getCompare); // ?base=initial|version:<id>&target=current|version:<id>
router.get("/:id/export", c.exportPlan);
router.post("/:id/decisions", requirePermission("workPlan.edit"), c.postDecision); // remove or defer, with reason
router.post("/:id/restore", requirePermission("workPlan.edit"), c.postRestore);
router.post("/:id/observations", requirePermission("workPlan.review", "workPlan.approve", "pcmed.review", "pcmed.approve"), c.postObservation);
router.post("/:id/outputs", requirePermission("workPlan.edit"), c.postOutput);
router.put("/:id/outputs/:outputId", requirePermission("workPlan.edit"), c.putOutput);
router.delete("/:id/outputs/:outputId", requirePermission("workPlan.edit"), c.removeOutput);
router.put("/:id/activities", requirePermission("workPlan.edit"), c.putActivity);
router.delete("/:id/activities/:activityId", requirePermission("workPlan.edit"), c.removeActivity);
router.patch("/:id/cost-items/:itemId", requirePermission("workPlan.edit"), c.patchCostItem);
router.post("/:id/submit", requirePermission("workPlan.submit"), c.postStep("submit"));
router.post("/:id/recommend", requirePermission("workPlan.review"), c.postStep("recommend"));
router.post("/:id/approve", requirePermission("workPlan.approve"), c.postStep("approve"));
router.post("/:id/start-verification", requirePermission("pcmed.review"), c.postStep("startVerification"));
router.post("/:id/verify", requirePermission("pcmed.approve"), c.postStep("verify"));
router.post("/:id/return", requirePermission("workPlan.return", "pcmed.return"), c.postReturn);

export default router;
