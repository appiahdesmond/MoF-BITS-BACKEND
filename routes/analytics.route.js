import { Router } from "express";
import { protectRoutes } from "../middleware/routesProtect.js";
import { requirePage } from "../utils/pageAccess.js";
import {
  getDashboardAnalytics,
  getExecutiveAnalytics,
  getExpenditureAnalysisData,
  getIgfAnalysisData,
} from "../controllers/analytics.controller.js";

const router = Router();

router.get("/dashboard", protectRoutes, requirePage("dashboard"), getDashboardAnalytics);
router.get("/executive", protectRoutes, requirePage("dashboard"), getExecutiveAnalytics);
router.get("/expenditure", protectRoutes, requirePage("expenditureAnalysis"), getExpenditureAnalysisData);
router.get("/igf", protectRoutes, requirePage("igfAnalysis"), getIgfAnalysisData);

export default router;
