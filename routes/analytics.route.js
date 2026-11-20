import { Router } from "express";
import { protectRoutes } from "../middleware/routesProtect.js";
import {
  getDashboardAnalytics,
  getExecutiveAnalytics,
  getExpenditureAnalysisData,
  getIgfAnalysisData,
} from "../controllers/analytics.controller.js";

const router = Router();

router.get("/dashboard", protectRoutes, getDashboardAnalytics);
router.get("/executive", protectRoutes, getExecutiveAnalytics);
router.get("/expenditure", protectRoutes, getExpenditureAnalysisData);
router.get("/igf", protectRoutes, getIgfAnalysisData);

export default router;
