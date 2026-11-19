import { Router } from "express";
import { protectRoutes } from "../middleware/routesProtect.js";
import { getDashboardAnalytics, getExecutiveAnalytics } from "../controllers/analytics.controller.js";

const router = Router();

router.get("/dashboard", protectRoutes, getDashboardAnalytics);
router.get("/executive", protectRoutes, getExecutiveAnalytics);

export default router;
