import User from "../models/users.js";
import { resolveOrganizationScope } from "../utils/resolveOrganizationScope.js";
import {
  getDashboardAnalyticsData,
  parseDashboardPeriod,
} from "../services/analytics.service.js";
import { getExecutiveData, resolveExecutivePeriod } from "../services/executive.service.js";

export const getDashboardAnalytics = async (req, res, next) => {
  try {
    const {
      organization,
      year,
      quarter,
      period,
      economicClassification,
      sourceOfFunding,
      revenueCategory,
      currencyType,
      dataStatus, // NEW: "Approved" | "Reviewed" | "Pending" | omitted = all
    } = req.query;

    const user = await User.findByPk(req.user.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not logged in",
      });
    }

    if (user.role !== "admin" && organization === "ALL") {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to access all organizations",
      });
    }

    const { organization: resolvedOrg, isAll } = resolveOrganizationScope({
      user,
      organization,
    });

    const parsedPeriod = parseDashboardPeriod({ year, quarter, period });

    const data = await getDashboardAnalyticsData({
      user,
      organization: resolvedOrg,
      period: parsedPeriod,
      economicClassification,
      sourceOfFunding,
      revenueCategory,
      currencyType,
      dataStatus,
    });

    res.json({
      success: true,
      organization: isAll ? "ALL" : resolvedOrg,
      period: {
        year: parsedPeriod.year,
        quarters: parsedPeriod.quarters,
        start: parsedPeriod.start,
        end: parsedPeriod.end,
      },
      ...data,
    });
  } catch (err) {
    next(err);
  }
};

export const getExecutiveAnalytics = async (req, res, next) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(401).json({ success: false, message: "User not logged in" });
    }
    const { organization: requested, year, month } = req.query;
    // Non-admins are always pinned to their own organisation.
    const { organization, isAll } = resolveOrganizationScope({ user, organization: requested });
    const period = await resolveExecutivePeriod({ organization, year, month });
    const data = await getExecutiveData({ organization, period });
    res.json({ success: true, organization: isAll ? "ALL" : organization, ...data });
  } catch (err) {
    next(err);
  }
};
