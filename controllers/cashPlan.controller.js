import ExcelJS from "exceljs";
import {
  approvedRequirements,
  getPlan,
  lineStatus,
  mapBudgetLine,
  unmappedBudgetLines,
  advancePlan,
  returnPlan,
  planForExport,
  planHistory,
  saveAllocations,
  saveJustification,
} from "../services/cashPlan.service.js";

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({ message: error.message, code: error.code, revision: error.revision, validation: error.validation });
    }
    next(error);
  }
};

export const getCashPlan = wrap(async (req, res) => res.json(await getPlan(req.user, req.query)));
export const putAllocations = wrap(async (req, res) => res.json(await saveAllocations(req.user, Number(req.params.id), req.body || {})));
export const putJustification = wrap(async (req, res) =>
  res.json(await saveJustification(req.user, Number(req.params.id), Number(req.params.lineId), req.body?.justification)),
);
export const postStep = (action) => wrap(async (req, res) => res.json(await advancePlan(req.user, Number(req.params.id), action, req.body || {})));
export const postReturn = wrap(async (req, res) => res.json(await returnPlan(req.user, Number(req.params.id), req.body || {})));
export const getHistory = wrap(async (req, res) => res.json({ data: await planHistory(req.user, Number(req.params.id)) }));
export const getUnmapped = wrap(async (req, res) => res.json({ data: await unmappedBudgetLines(req.user, req.query) }));
export const patchBudgetLineActivity = wrap(async (req, res) => res.json(await mapBudgetLine(req.user, Number(req.params.id), req.body || {})));
export const getApproved = wrap(async (req, res) => res.json(await approvedRequirements(req.user, req.query)));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CLASS_ABBR = { "Compensation of Employees": "COE", "Goods and Services": "G&S", "Capital Expenditure": "CAPEX" };
const STATUS_LABEL = { notStarted: "Not started", partial: "Partially allocated", full: "Fully allocated", over: "Over-allocated" };
const money = "#,##0.00";

/** Excel workbook: the plan by activity, then requirements by classification and funding source. */
export const exportCashPlan = wrap(async (req, res) => {
  const { plan, lines } = await planForExport(req.user, Number(req.params.id));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Cash Plan");
  ws.addRow([`Annual Cash Plan ${plan.year} — ${plan.organization}`]).font = { bold: true, size: 13 };
  ws.addRow([`Status: ${plan.status}   ·   Amounts in GH₵`]);
  ws.addRow([]);
  const head = ws.addRow(["Activity/Operation Code", "Activity/Operation", "Class", "Fund", "Policy", "Budget Allocation", ...MONTHS, "Year Total", "Balance", "Status"]);
  head.font = { bold: true };
  const totals = Array(12).fill(0);
  let budget = 0;
  for (const l of lines) {
    const t = l.monthsCents.reduce((a, b) => a + b, 0);
    l.monthsCents.forEach((c, i) => (totals[i] += c));
    budget += l.budgetCents;
    ws.addRow([
      l.activityCode || "",
      l.activity || "Activity not assigned",
      CLASS_ABBR[l.economicClassification] || l.economicClassification,
      l.sourceOfFunding,
      l.policyClassification === "KPI" ? "Key Policy Initiative" : "Normal",
      l.budgetCents / 100,
      ...l.monthsCents.map((c) => c / 100),
      t / 100,
      (l.budgetCents - t) / 100,
      STATUS_LABEL[lineStatus(l.budgetCents, t)],
    ]);
  }
  const all = totals.reduce((a, b) => a + b, 0);
  const totalRow = ws.addRow(["", "Grand Total", "", "", "", budget / 100, ...totals.map((c) => c / 100), all / 100, (budget - all) / 100, ""]);
  totalRow.font = { bold: true };
  ws.columns.forEach((col, i) => {
    col.width = i === 1 ? 44 : i === 0 ? 20 : i < 5 ? 10 : 15;
    if (i >= 5 && i <= 19) col.numFmt = money;
  });

  // By classification and funding source (as in the statutory cash plan summary).
  const sum = wb.addWorksheet("By Classification");
  sum.addRow(["Economic Classification", "Fund", "Budget", ...MONTHS, "Total"]).font = { bold: true };
  const groups = new Map();
  for (const l of lines) {
    const k = `${l.economicClassification}|${l.sourceOfFunding}`;
    const g = groups.get(k) ?? { cls: l.economicClassification, fund: l.sourceOfFunding, budget: 0, months: Array(12).fill(0) };
    g.budget += l.budgetCents;
    l.monthsCents.forEach((c, i) => (g.months[i] += c));
    groups.set(k, g);
  }
  for (const g of groups.values())
    sum.addRow([g.cls, g.fund, g.budget / 100, ...g.months.map((c) => c / 100), g.months.reduce((a, b) => a + b, 0) / 100]);
  sum.columns.forEach((col, i) => {
    col.width = i === 0 ? 30 : i === 1 ? 8 : 15;
    if (i >= 2) col.numFmt = money;
  });

  const safe = plan.organization.replace(/[^\w-]+/g, "_");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename=cash_plan_${plan.year}_${safe}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});
