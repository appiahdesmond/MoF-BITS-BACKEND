import { complianceFor } from "../services/compliance.service.js";
import { dadScope } from "../utils/dataScope.js";

// GET /api/compliance?year=&month= — the month whose submissions are reported on.
// Defaults to the previous month (the latest one whose submissions are due).
export const getCompliance = async (req, res, next) => {
  try {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const year = Number(req.query.year) || prev.getFullYear();
    const month = Number(req.query.month) || prev.getMonth() + 1;
    if (month < 1 || month > 12) {
      return next(Object.assign(new Error("Month must be 1–12"), { statusCode: 400 }));
    }
    const scope = await dadScope(req.user);
    res.json({ success: true, scope, ...(await complianceFor({ year, month, scope, now })) });
  } catch (error) {
    next(error);
  }
};
