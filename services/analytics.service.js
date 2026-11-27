import { Op, fn, col, where as sqlWhere } from "sequelize";
import BudgetExpenditure from "../models/expenditure.model.js";
import Revenue from "../models/revenue.model.js";
import LoadedData from "../models/loadedData.js";
import { getCashPositionData, groupCashPositionData, totalCashPositionSummary } from "./cashReport.service.js";
import {
  getReallocationSummaryData,
  groupReallocationSummary,
  totalReallocationSummary,
} from "./reallocationReport.service.js";
import { parseDashboardPeriod } from "./analytics.period.js";
import {
  round2,
  round3,
  safePct,
  percentChange,
  periodTiming,
  spendStatus,
  igfStatus,
  monthsOfCover,
  buildPerformanceRow,
  buildAlerts,
  buildInsights,
  resolveIgfTargets,
  STATUS_RANK,
} from "./analytics.metrics.js";
import { seesAllDads } from "../utils/dataScope.js";

export { parseDashboardPeriod };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CURRENCIES = ["GHS", "EUR", "GBP", "USD"];
const DATA_STATUSES = ["Pending", "Reviewed", "Approved"];

// Revenue.budgetProjections is typed in by hand on each record.
//   "latest": the newest non-zero entry per DAD + category is the whole-year target
//   "sum":    every entry is its own slice of the target and they add up
// Switch this one value if your team enters targets the other way.
const IGF_TARGET_MODE = "latest";

const CATEGORY_LABELS = {
  "fees/charges": "Fees/Charges",
  fines: "Fines/Forfeitures",
  "fines/forfeitures": "Fines/Forfeitures",
  interests: "Interests",
  licenses: "Licenses",
  others: "Others",
  "sale of goods and services": "Sale Of Goods and Services",
};
const categoryLabel = (raw) => CATEGORY_LABELS[String(raw || "").toLowerCase()] || raw || "Unknown";

const isAll = (value) => !value || String(value).toUpperCase() === "ALL";
const normaliseStatus = (value) => {
  const match = DATA_STATUSES.find((s) => s.toLowerCase() === String(value || "").toLowerCase());
  return match || "ALL";
};

const matchesFilter = (value, filter) =>
  isAll(filter) || String(value || "").toLowerCase() === String(filter).trim().toLowerCase();

function formatDay(value) {
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Query helpers. Every one takes the same scope object so filters stay aligned:
//   { organization, fund, econ, revenueCategory, status }
// ---------------------------------------------------------------------------

const orgClause = (organization) => (organization ? { organization } : {});

const categoryClause = (revenueCategory) =>
  isAll(revenueCategory)
    ? {}
    : {
        [Op.and]: [
          sqlWhere(fn("LOWER", col("revenue_category")), String(revenueCategory).trim().toLowerCase()),
        ],
      };

const statusClause = (status) => (status && status !== "ALL" ? { status } : {});

/** Appropriation + allotment come from LoadedData only. Never sum the per-row copies on the expenditure table. */
async function appropriationGrouped({ year, organization, fund, econ, groupBy }) {
  const where = { year, ...orgClause(organization) };
  if (!isAll(fund)) where.sourceOfFunding = fund;
  if (!isAll(econ)) where.economicClassification = econ;

  return LoadedData.findAll({
    where,
    attributes: [
      ...(groupBy ? [groupBy] : []),
      [fn("SUM", col("appropriation")), "appropriation"],
      [fn("SUM", col("allotment")), "allotment"],
    ],
    ...(groupBy ? { group: [groupBy] } : {}),
    raw: true,
  });
}

async function expenditureGrouped({ start, end, organization, fund, econ, status, groupBy }) {
  const where = { date: { [Op.between]: [start, end] }, ...orgClause(organization), ...statusClause(status) };
  if (!isAll(fund)) where.sourceOfFunding = fund;
  if (!isAll(econ)) where.economicClassification = econ;

  return BudgetExpenditure.findAll({
    where,
    attributes: [
      ...(groupBy ? [groupBy] : []),
      [fn("SUM", col("releases")), "releases"],
      [fn("SUM", col("actualExpenditure")), "expenditure"],
      [fn("SUM", col("actualPayment")), "payment"],
    ],
    ...(groupBy ? { group: [groupBy] } : {}),
    raw: true,
  });
}

async function expenditureByQuarter({ year, organization, fund, econ, status }) {
  const where = {
    date: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] },
    ...orgClause(organization),
    ...statusClause(status),
  };
  if (!isAll(fund)) where.sourceOfFunding = fund;
  if (!isAll(econ)) where.economicClassification = econ;

  const quarterExpr = fn("QUARTER", col("date"));
  return BudgetExpenditure.findAll({
    where,
    attributes: [
      [quarterExpr, "quarter"],
      [fn("SUM", col("releases")), "releases"],
      [fn("SUM", col("actualExpenditure")), "expenditure"],
      [fn("SUM", col("actualPayment")), "payment"],
    ],
    group: [quarterExpr],
    raw: true,
  });
}

async function igfGrouped({ start, end, organization, revenueCategory, status, groupBy }) {
  const where = {
    date: { [Op.between]: [start, end] },
    ...orgClause(organization),
    ...categoryClause(revenueCategory),
    ...statusClause(status),
  };
  const groupExpr = groupBy === "category" ? fn("LOWER", col("revenue_category")) : col("organization");

  return Revenue.findAll({
    where,
    attributes: [
      [groupExpr, "groupKey"],
      [fn("SUM", col("actual_collection")), "actual"],
      [fn("SUM", col("retention_amount")), "retention"],
      [fn("SUM", col("payment_amount")), "remitted"],
    ],
    group: [groupExpr],
    raw: true,
  });
}

/** Whole-year IGF targets. Not filtered by approval status: they are planning figures. */
async function igfTargets({ year, organization, revenueCategory }) {
  const rows = await Revenue.findAll({
    where: {
      date: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] },
      budgetProjections: { [Op.gt]: 0 },
      ...orgClause(organization),
      ...categoryClause(revenueCategory),
    },
    attributes: ["organization", [fn("LOWER", col("revenue_category")), "category"], "budgetProjections"],
    order: [
      ["date", "DESC"],
      ["id", "DESC"],
    ],
    raw: true,
  });
  return resolveIgfTargets(rows, IGF_TARGET_MODE);
}

async function igfTotal({ start, end, organization, revenueCategory, status }) {
  const where = {
    date: { [Op.between]: [start, end] },
    ...orgClause(organization),
    ...categoryClause(revenueCategory),
    ...statusClause(status),
  };
  const [row] = await Revenue.findAll({
    where,
    attributes: [[fn("SUM", col("actual_collection")), "actual"]],
    raw: true,
  });
  return round2(row?.actual);
}

/** Records that are not yet Approved, inside the current view. */
async function pendingSummary({ start, end, organization, fund, econ, revenueCategory }) {
  const dateRange = { [Op.between]: [start, end] };
  const notApproved = { [Op.ne]: "Approved" };

  const expWhere = { date: dateRange, status: notApproved, ...orgClause(organization) };
  if (!isAll(fund)) expWhere.sourceOfFunding = fund;
  if (!isAll(econ)) expWhere.economicClassification = econ;

  const [[exp], [rev]] = await Promise.all([
    BudgetExpenditure.findAll({
      where: expWhere,
      attributes: [
        [fn("COUNT", col("id")), "count"],
        [fn("SUM", col("actualExpenditure")), "amount"],
      ],
      raw: true,
    }),
    Revenue.findAll({
      where: { date: dateRange, status: notApproved, ...orgClause(organization), ...categoryClause(revenueCategory) },
      attributes: [
        [fn("COUNT", col("id")), "count"],
        [fn("SUM", col("actual_collection")), "amount"],
      ],
      raw: true,
    }),
  ]);

  return {
    count: Number(exp?.count || 0) + Number(rev?.count || 0),
    expenditureRecords: Number(exp?.count || 0),
    expenditureAmount: round2(exp?.amount),
    revenueRecords: Number(rev?.count || 0),
    revenueAmount: round2(rev?.amount),
  };
}

async function cashSnapshot({ start, end, organization, currencyType, status }) {
  const raw = await getCashPositionData({ start_date: start, end_date: end, organization, status });
  const grouped = groupCashPositionData(raw);
  const totals = totalCashPositionSummary(grouped);
  const currency =
    currencyType && CURRENCIES.includes(String(currencyType).toUpperCase())
      ? String(currencyType).toUpperCase()
      : "GHS";

  return {
    currency,
    amount: round2(totals[currency] || 0),
    totals: Object.fromEntries(CURRENCIES.map((c) => [c, round2(totals[c] || 0)])),
    byCategory: grouped.map(({ account_name, GHS, EUR, GBP, USD }) => ({
      category: account_name,
      GHS: round2(GHS),
      EUR: round2(EUR),
      GBP: round2(GBP),
      USD: round2(USD),
    })),
  };
}

async function reallocationTotals({ start, end, organization, fund, econ, status }) {
  const raw = await getReallocationSummaryData({
    start_date: start,
    end_date: end,
    organization,
    sourceOfFunding: fund,
    status,
  });
  const grouped = groupReallocationSummary(raw);
  const filtered = isAll(econ) ? grouped : grouped.filter((row) => matchesFilter(row.title, econ));
  const totals = totalReallocationSummary(filtered);

  const reallocatedAmount = round2(totals.reallocated);
  const released = round2(totals.released);
  const actualExpenditure = round2(totals.expenditure);
  const actualPayment = round2(totals.payment);

  return {
    reallocatedAmount,
    released,
    actualExpenditure,
    actualPayment,
    releaseRatePct: safePct(released, reallocatedAmount),
    spendRatePct: safePct(actualExpenditure, released),
    paymentRatePct: safePct(actualPayment, actualExpenditure),
  };
}

async function dailyTrend({ model, amountCol, start, end, organization, extraWhere = {} }) {
  const rows = await model.findAll({
    where: { date: { [Op.between]: [start, end] }, ...orgClause(organization), ...extraWhere },
    attributes: [
      [col("date"), "day"],
      [fn("SUM", col(amountCol)), "amount"],
    ],
    group: [col("date")],
    order: [[col("date"), "ASC"]],
    raw: true,
  });

  return rows.map((row) => {
    const date = formatDay(row.day);
    return { date, month: MONTHS[Number(date.slice(5, 7)) - 1] || "", amount: round2(row.amount) };
  });
}

const indexBy = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r]));
const n = (value) => Number(value) || 0;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function getDashboardAnalyticsData({
  user,
  organization,
  period,
  economicClassification,
  sourceOfFunding = "ALL",
  revenueCategory,
  currencyType,
  dataStatus,
}) {
  const parsed = typeof period === "object" && period?.year ? period : parseDashboardPeriod(period);
  const fund = isAll(sourceOfFunding) ? "ALL" : sourceOfFunding;
  const econ = isAll(economicClassification) ? "ALL" : economicClassification;
  const status = normaliseStatus(dataStatus);

  // Users without a ministry-wide scope are pinned to their own DAD, whatever the controller passed.
  const scopeOrg = seesAllDads(user) ? organization : user.organization;

  const base = { organization: scopeOrg, fund, econ, revenueCategory, status };
  const { year, start, end } = parsed;
  const timing = periodTiming(parsed);

  const [
    appropriationTotal,
    appropriationByOrg,
    appropriationByEcon,
    expenditureTotal,
    expenditureByOrg,
    expenditureByEcon,
    quarterlyRows,
    prevExpenditureTotal,
    igfByOrg,
    igfByCategory,
    targets,
    currentIgf,
    prevIgf,
    currentCash,
    prevCash,
    reallocation,
    igfCollectionTrend,
    expenditureTrend,
    pending,
  ] = await Promise.all([
    appropriationGrouped({ year, ...base }),
    appropriationGrouped({ year, ...base, groupBy: "organization" }),
    appropriationGrouped({ year, ...base, groupBy: "economicClassification" }),
    expenditureGrouped({ start, end, ...base }),
    expenditureGrouped({ start, end, ...base, groupBy: "organization" }),
    expenditureGrouped({ start, end, ...base, groupBy: "economicClassification" }),
    expenditureByQuarter({ year, ...base }),
    expenditureGrouped({ start: parsed.prevStart, end: parsed.prevEnd, ...base }),
    igfGrouped({ start, end, ...base, groupBy: "organization" }),
    igfGrouped({ start, end, ...base, groupBy: "category" }),
    igfTargets({ year, organization: scopeOrg, revenueCategory }),
    igfTotal({ start, end, ...base }),
    igfTotal({ start: parsed.prevStart, end: parsed.prevEnd, ...base }),
    cashSnapshot({ start, end, organization: scopeOrg, currencyType, status }),
    cashSnapshot({ start: parsed.prevStart, end: parsed.prevEnd, organization: scopeOrg, currencyType, status }),
    reallocationTotals({ start, end, ...base }),
    dailyTrend({
      model: Revenue,
      amountCol: "actual_collection",
      start,
      end,
      organization: scopeOrg,
      extraWhere: { ...categoryClause(revenueCategory), ...statusClause(status) },
    }),
    dailyTrend({
      model: BudgetExpenditure,
      amountCol: "actualExpenditure",
      start,
      end,
      organization: scopeOrg,
      extraWhere: {
        ...(!isAll(fund) ? { sourceOfFunding: fund } : {}),
        ...(!isAll(econ) ? { economicClassification: econ } : {}),
        ...statusClause(status),
      },
    }),
    pendingSummary({ start, end, ...base }),
  ]);

  // ---- Totals -------------------------------------------------------------
  const budget = n(appropriationTotal[0]?.appropriation);
  const allotment = n(appropriationTotal[0]?.allotment);
  const releases = n(expenditureTotal[0]?.releases);
  const expenditure = n(expenditureTotal[0]?.expenditure);
  const payment = n(expenditureTotal[0]?.payment);
  const prevExpenditure = n(prevExpenditureTotal[0]?.expenditure);

  const expectedSpend = budget * timing.expectedFraction;
  const igfTargetYear = Object.values(targets.byOrg).reduce((a, b) => a + b, 0);
  const igfTargetToDate = igfTargetYear * timing.expectedFraction;

  // ---- Per-DAD performance ------------------------------------------------
  const appByOrg = indexBy(appropriationByOrg, "organization");
  const expByOrg = indexBy(expenditureByOrg, "organization");
  const igfOrg = indexBy(igfByOrg, "groupKey");
  const orgKeys = new Set([
    ...Object.keys(appByOrg),
    ...Object.keys(expByOrg),
    ...Object.keys(igfOrg),
  ]);

  const dadPerformance = [...orgKeys]
    .map((key) =>
      buildPerformanceRow({
        key,
        appropriation: n(appByOrg[key]?.appropriation),
        allotment: n(appByOrg[key]?.allotment),
        releases: n(expByOrg[key]?.releases),
        expenditure: n(expByOrg[key]?.expenditure),
        payment: n(expByOrg[key]?.payment),
        igfActual: n(igfOrg[key]?.actual),
        igfTarget: n(targets.byOrg[key]) * timing.expectedFraction,
        retention: n(igfOrg[key]?.retention),
        remitted: n(igfOrg[key]?.remitted),
        expectedFraction: timing.expectedFraction,
      }),
    )
    .sort(
      (a, b) =>
        (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0) ||
        b.expenditure - a.expenditure,
    )
    .map(({ key, ...rest }) => ({ organization: key, ...rest }));

  // ---- Economic classification breakdown ----------------------------------
  const appByEcon = indexBy(appropriationByEcon, "economicClassification");
  const expByEcon = indexBy(expenditureByEcon, "economicClassification");
  const ECON_ORDER = ["Compensation of Employees", "Goods and Services", "Capital Expenditure"];
  const economicBreakdown = [...new Set([...Object.keys(appByEcon), ...Object.keys(expByEcon)])]
    .map((key) =>
      buildPerformanceRow({
        key,
        appropriation: n(appByEcon[key]?.appropriation),
        allotment: n(appByEcon[key]?.allotment),
        releases: n(expByEcon[key]?.releases),
        expenditure: n(expByEcon[key]?.expenditure),
        payment: n(expByEcon[key]?.payment),
        expectedFraction: timing.expectedFraction,
      }),
    )
    .sort((a, b) => {
      const ia = ECON_ORDER.indexOf(a.key);
      const ib = ECON_ORDER.indexOf(b.key);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .map(({ key, ...rest }) => ({ classification: key, ...rest }));

  // ---- Budget execution by quarter (whole selected year) -------------------
  const quarterIndex = indexBy(quarterlyRows, "quarter");
  const quarterly = [1, 2, 3, 4].map((q) => {
    const row = quarterIndex[q] || {};
    return {
      quarter: `Q${q}`,
      selected: parsed.quarters.includes(q),
      expected: round2(budget / 4),
      releases: round2(row.releases),
      expenditure: round2(row.expenditure),
      payment: round2(row.payment),
    };
  });

  // ---- IGF -----------------------------------------------------------------
  const igfRetention = igfByOrg.reduce((s, r) => s + n(r.retention), 0);
  const igfRemitted = igfByOrg.reduce((s, r) => s + n(r.remitted), 0);

  const categoryRows = igfByCategory.map((r) => ({
    category: categoryLabel(r.groupKey),
    rawKey: String(r.groupKey || "").toLowerCase(),
    actual: n(r.actual),
  }));
  // Include categories that have a target but no collection yet.
  for (const key of Object.keys(targets.byCategory)) {
    if (!categoryRows.some((c) => c.rawKey === key)) {
      categoryRows.push({ category: categoryLabel(key), rawKey: key, actual: 0 });
    }
  }
  const igfCategories = categoryRows
    .map(({ category, rawKey, actual }) => {
      const target = n(targets.byCategory[rawKey]) * timing.expectedFraction;
      return {
        category,
        actual: round2(actual),
        target: round2(target),
        attainmentPct: target ? safePct(actual, target) : null,
        status: igfStatus({ actual, target }),
      };
    })
    .sort((a, b) => b.actual - a.actual);

  const igfGrand = igfByOrg.reduce((s, r) => s + n(r.actual), 0);
  const topIgfDads = [...igfByOrg]
    .sort((a, b) => n(b.actual) - n(a.actual))
    .slice(0, 5)
    .map((r) => ({
      organization: r.groupKey,
      amount: round2(r.actual),
      percent: igfGrand ? round2((n(r.actual) / igfGrand) * 100) : 0,
    }));

  const igf = {
    actual: currentIgf,
    targetYear: round2(igfTargetYear),
    targetToDate: round2(igfTargetToDate),
    attainmentPct: igfTargetToDate ? safePct(currentIgf, igfTargetToDate) : null,
    retained: round2(igfRetention),
    remitted: round2(igfRemitted),
    retentionSharePct: safePct(igfRetention, igfRetention + igfRemitted),
    topFiveSharePct: round2(topIgfDads.reduce((s, d) => s + d.percent, 0)),
    targetMode: IGF_TARGET_MODE,
    byCategory: igfCategories,
  };

  // ---- Liquidity -----------------------------------------------------------
  // Months of cover only uses GHS: there are no exchange rates to convert the rest.
  const cover = monthsOfCover({
    cash: currentCash.totals.GHS,
    expenditure,
    elapsedDays: timing.elapsedDays,
  });
  const liquidity = {
    ghsCash: currentCash.totals.GHS,
    totals: currentCash.totals,
    monthlyBurn: cover?.monthlyBurn ?? null,
    months: cover?.months ?? null,
    byCategory: currentCash.byCategory,
  };

  // ---- Summary -------------------------------------------------------------
  const pacePct = expectedSpend ? safePct(expenditure, expectedSpend) : null;
  const summary = {
    totalBudget: round2(budget),
    totalAllotment: round2(allotment),
    releases: round2(releases),
    releaseRatePct: safePct(releases, allotment),
    expenditureToDate: round2(expenditure),
    expenditureChangePct: percentChange(expenditure, prevExpenditure),
    budgetUtilisationPct: round3(budget ? (expenditure / budget) * 100 : 0),
    expectedSpend: round2(expectedSpend),
    pacePct,
    spendStatus: spendStatus({ expenditure, expected: expectedSpend, appropriation: budget }),
    payments: round2(payment),
    unpaid: round2(expenditure - payment),
    unpaidSharePct: safePct(expenditure - payment, expenditure),
    variance: round2(budget - expenditure),
    igfCollectionToDate: currentIgf,
    igfChangePct: percentChange(currentIgf, prevIgf),
    igfStatus: igfStatus({ actual: currentIgf, target: igfTargetToDate }),
    cashPositionToDate: currentCash.amount,
    cashCurrency: currentCash.currency,
    cashPositionChangePct: percentChange(currentCash.amount, prevCash.amount),
  };

  const alerts = buildAlerts({ rows: dadPerformance, liquidity, pending });

  return {
    meta: {
      dataStatus: status,
      comparisonLabel:
        parsed.quarters.length === 1 ? "vs previous quarter" : `vs ${parsed.prevYear}`,
      expectedPct: round2(timing.expectedFraction * 100),
      expectedBasis: "Appropriation spread evenly by day across the year",
      isInProgress: timing.isInProgress,
      currencyNote: "Budget, expenditure and IGF are reported in GH₵. The currency filter applies to cash only.",
    },
    summary,
    budgetExecution: {
      funnel: [
        { stage: "Appropriation", amount: round2(budget) },
        { stage: "Allotment", amount: round2(allotment) },
        { stage: "Releases", amount: round2(releases) },
        { stage: "Expenditure", amount: round2(expenditure) },
        { stage: "Payment", amount: round2(payment) },
      ],
      quarterly,
    },
    dadPerformance,
    economicBreakdown,
    igf,
    liquidity,
    alerts,
    pending,
    insights: buildInsights({ summary, liquidity, igf }),
    // Existing keys, kept so older pieces of the UI keep working.
    igfCollectionTrend,
    expenditureTrend,
    topIgfDads,
    reallocation,
    cashPositionByCategory: currentCash.byCategory,
  };
}
