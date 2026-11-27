import { Router } from "express";
import multer from "multer";
import { protectRoutes } from "../middleware/routesProtect.js";
import { requirePage } from "../utils/pageAccess.js";
import { requirePermission } from "../utils/permissions.js";
import * as c from "../controllers/budgetCeiling.controller.js";

// Budget Ceilings. DAD officers only reach their own published ceiling (/my); everything else
// needs a Budget Ceilings permission. The service re-checks each workflow step.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const router = Router();
router.use(protectRoutes, requirePage("budgetCeilings"));
const VIEW = ["ceilings.view", "ceilings.prepare", "ceilings.recommend", "ceilings.endorse", "ceilings.approve"];

router.get("/my", c.getMine); // ?year= the DAD's own approved ceiling
router.get("/my/export", c.exportMine);
router.post("/my/:id/acknowledge", c.postAcknowledge);

router.use(requirePermission(...VIEW));
router.get("/", c.getWorkspace); // ?year=
router.get("/awaiting", c.getAwaiting);
router.get("/monitoring", c.getMonitoring); // ?year=
router.get("/ministry-ceilings", c.getMinistryCeilings); // ?year=
router.post("/ministry-ceiling", requirePermission("ceilings.prepare"), upload.single("document"), c.postMinistryCeiling);
router.get("/documents/:docId", c.getDocument);
router.get("/:id", c.getDistribution);
router.get("/:id/history", c.getHistory);
router.get("/:id/export", c.exportSchedules);
router.put("/:id/allocations", requirePermission("ceilings.prepare"), c.putAllocations);
router.post("/:id/submit", requirePermission("ceilings.prepare"), c.postStep("submit"));
router.post("/:id/recommend", requirePermission("ceilings.recommend"), c.postStep("recommend"));
router.post("/:id/endorse", requirePermission("ceilings.endorse"), c.postStep("endorse"));
router.post("/:id/approve", requirePermission("ceilings.approve"), c.postStep("approve"));
router.post("/:id/return", requirePermission("ceilings.recommend", "ceilings.endorse", "ceilings.approve"), c.postReturn);
router.post("/:id/retry-communication", requirePermission("ceilings.prepare"), c.postRetry);

export default router;
