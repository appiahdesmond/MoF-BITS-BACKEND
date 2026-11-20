// Executive Financial Dashboard: one month of approved figures plus the
// year-to-date context around it. Read-only; uses existing tables only.
//
// Rules
// - Only Approved records count as verified figures.
// - Monthly series run Jan..selected month. A month with no approved records
//   is null (no data), never 0.
// - Cash closing balance for a month = sum, per currency, of each account's
//   latest approved balance dated within that month. Currencies are never
//   added together or converted.
import { Op, fn, col, literal } from "sequelize";
import BudgetExpenditure from "../models/expenditure.model.js";
import Revenue from "../models/revenue.model.js";
import Cash from "../models/cash.model.js";
import LoadedData from "../models/loadedData.js";
import User from "../models/users.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FUNDS = [
  { key: "GOG", label: "GoG" },
  { key: "IGF", label: "IGF" },
  { key: "DPF", label: "DP" },
];
const DEMO_USERNAME = "demo_seed";

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pad = (n) => String(n).padStart(2, "0");
const monthEnd = (year, month) => `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const orgWhere = (organization) => (organization ? { organization } : {});

/** Latest reporting month (YYYY-MM) with approved records in scope. */
async function latestApprovedMonth(organization, year) {
  const range = (field) =>
    year ? { [field]: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } } : {};
  const base = { ...orgWhere(organization), status: "Approved" };
  const [e, r, c] = await Promise.all([
    BudgetExpenditure.max("date", { where: { ...base, ...range("date") } }),
    Revenue.max("date", { where: { ...base, ...range("date") } }),
    Cash.max("as_at_date", { where: { ...base, ...range("as_at_date") } }),
  ]);
  // Expenditure is the core monthly return, so it sets the reporting month when
  // present; IGF and cash only decide it when no expenditure is approved yet.
  if (e) return day(e).slice(0, 7);
  const dates = [r, c].filter(Boolean).map(day).sort();
  return dates.length ? dates[dates.length - 1].slice(0, 7) : null;
}

async function availableYears(organization) {
  const where = orgWhere(organization);
  const yearsOf = (model, field) =>
    model.findAll({ attributes: [[fn("DISTINCT", fn("YEAR", col(field))), "y"]], where, raw: true });
  const [e, r, c, b] = await Promise.all([
    yearsOf(BudgetExpenditure, "date"),
    yearsOf(Revenue, "date"),
    yearsOf(Cash, "as_at_date"),
    LoadedData.findAll({ attributes: [[fn("DISTINCT", col("year")), "y"]], where, raw: true }),
  ]);
  return [...new Set([...e, ...r, ...c, ...b].map((row) => Number(row.y)).filter(Boolean))].sort((a, b2) => b2 - a);
}

/** Resolve year and month: explicit values win, else the latest verified month. */
export async function resolveExecutivePeriod({ organization, year, month }) {
  const now = new Date();
  let y = Number(year) || null;
  let m = Number(month) || null;
  if (m && (m < 1 || m > 12)) m = null;
  const latestOverall = await latestApprovedMonth(organization, null);
  if (!y) y = latestOverall ? Number(latestOverall.slice(0, 4)) : now.getFullYear();
  const latestInYear = await latestApprovedMonth(organization, y);
  if (!m) {
    if (latestInYear) m = Number(latestInYear.slice(5, 7));
    else m = y < now.getFullYear() ? 12 : now.getMonth() + 1;
  }
  return {
    year: y,
    month: m,
    start: `${y}-01-01`,
    monthStart: `${y}-${pad(m)}-01`,
    end: monthEnd(y, m),
    latestVerifiedMonth: latestOverall,
    latestVerifiedMonthInYear: latestInYear,
  };
}

/** Monthly sums Jan..month with record counts, so empty months become null. */
async function monthlySums(model, dateField, sums, organization, period, extraWhere = {}) {
  const rows = await model.findAll({
    attributes: [
      [fn("MONTH", col(dateField)), "m"],
      [fn("COUNT", col("id")), "n"],
      ...sums.map((field) => [fn("SUM", col(field)), field]),
    ],
    where: {
      ...orgWhere(organization),
      ...extraWhere,
      status: "Approved",
      [dateField]: { [Op.between]: [period.start, period.end] },
    },
    group: [fn("MONTH", col(dateField))],
    raw: true,
  });
  const byMonth = Object.fromEntries(rows.map((r) => [Number(r.m), r]));
  return Array.from({ length: period.month }, (_, i) => {
    const r = byMonth[i + 1];
    const out = { month: MONTHS[i], records: r ? Number(r.n) : 0 };
    sums.forEach((field) => {
      out[field] = r && Number(r.n) > 0 ? round2(r[field]) : null;
    });
    return out;
  });
}

async function cashByCurrency(organization, period) {
  const rows = await Cash.findAll({
    attributes: ["organization", "account_name", "currency", "as_at_date", "balance", "id"],
    where: {
      ...orgWhere(organization),
      status: "Approved",
      as_at_date: { [Op.between]: [period.start, period.end] },
    },
    order: [["as_at_date", "ASC"], ["id", "ASC"]],
    raw: true,
  });
  // latest[currency][month][account] = balance (later rows overwrite earlier ones)
  const latest = {};
  rows.forEach((r) => {
    const m = Number(day(r.as_at_date).slice(5, 7));
    const acct = `${r.organization}|${r.account_name}`;
    latest[r.currency] ??= {};
    latest[r.currency][m] ??= {};
    latest[r.currency][m][acct] = Number(r.balance) || 0;
  });
  const currencies = Object.keys(latest).sort((a, b) => (a === "GHS" ? -1 : b === "GHS" ? 1 : a.localeCompare(b)));
  const series = Object.fromEntries(
    currencies.map((cur) => [
      cur,
      Array.from({ length: period.month }, (_, i) => {
        const accounts = latest[cur][i + 1];
        return {
          month: MONTHS[i],
          balance: accounts ? round2(Object.values(accounts).reduce((a, b) => a + b, 0)) : null,
          accounts: accounts ? Object.keys(accounts).length : 0,
        };
      }),
    ]),
  );
  return { currencies, series };
}

async function approvedBudget(organization, year) {
  const rows = await LoadedData.findAll({
    attributes: ["sourceOfFunding", [fn("SUM", col("appropriation")), "total"], [fn("COUNT", col("id")), "n"]],
    where: { ...orgWhere(organization), year },
    group: ["sourceOfFunding"],
    raw: true,
  });
  const bySource = Object.fromEntries(rows.map((r) => [String(r.sourceOfFunding).toUpperCase(), round2(r.total)]));
  const lines = rows.reduce((a, r) => a + Number(r.n), 0);
  return { total: lines ? round2(rows.reduce((a, r) => a + Number(r.total || 0), 0)) : null, bySource, lines };
}

async function ytdBySource(organization, period) {
  const rows = await BudgetExpenditure.findAll({
    attributes: ["sourceOfFunding", [fn("SUM", col("actualExpenditure")), "total"]],
    where: {
      ...orgWhere(organization),
      status: "Approved",
      date: { [Op.between]: [period.start, period.end] },
    },
    group: ["sourceOfFunding"],
    raw: true,
  });
  return Object.fromEntries(rows.map((r) => [String(r.sourceOfFunding).toUpperCase(), round2(r.total)]));
}

/** Top 5 contributors for the month: by DAD, or within one DAD by activity / category. */
async function contributors(organization, period) {
  const monthRange = { [Op.between]: [period.monthStart, period.end] };
  const expField = organization ? "activity" : "organization";
  const igfField = organization ? "revenue_category" : "organization";
  const [exp, igf] = await Promise.all([
    BudgetExpenditure.findAll({
      attributes: [[col(expField), "name"], [fn("SUM", col("actualExpenditure")), "amount"]],
      where: { ...orgWhere(organization), status: "Approved", date: monthRange },
      group: [col(expField)],
      raw: true,
    }),
    Revenue.findAll({
      attributes: [[col(igfField), "name"], [fn("SUM", col("actual_collection")), "amount"]],
      where: { ...orgWhere(organization), status: "Approved", date: monthRange },
      group: [col(igfField)],
      raw: true,
    }),
  ]);
  const top = (rows) => {
    const total = rows.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    const items = rows
      .map((r) => ({ name: r.name || "Unspecified", amount: round2(r.amount) }))
      .filter((r) => r.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    return {
      total: round2(total),
      count: items.length,
      top: items.slice(0, 5).map((r) => ({ ...r, share: total > 0 ? round2((r.amount / total) * 100) : null })),
    };
  };
  return {
    groupBy: organization ? { expenditure: "activity", igf: "revenue category" } : { expenditure: "DAD", igf: "DAD" },
    expenditure: top(exp),
    igf: top(igf),
  };
}

/** Records in the selected month that are not yet approved. */
async function unverifiedInMonth(organization, period) {
  const notApproved = { [Op.ne]: "Approved" };
  const range = { [Op.between]: [period.monthStart, period.end] };
  const [e, r, c] = await Promise.all([
    BudgetExpenditure.count({ where: { ...orgWhere(organization), status: notApproved, date: range } }),
    Revenue.count({ where: { ...orgWhere(organization), status: notApproved, date: range } }),
    Cash.count({ where: { ...orgWhere(organization), status: notApproved, as_at_date: range } }),
  ]);
  return { expenditure: e, igf: r, cash: c, total: e + r + c };
}

/** True when any record in the year belongs to the demo seed account. */
async function hasIllustrativeData(organization, period) {
  const demo = await User.findOne({ where: { username: DEMO_USERNAME }, attributes: ["id"], raw: true });
  if (!demo) return false;
  const yearRange = { [Op.between]: [period.start, `${period.year}-12-31`] };
  const where = orgWhere(organization);
  const [e, r, c] = await Promise.all([
    BudgetExpenditure.count({ where: { ...where, userId: demo.id, date: yearRange } }),
    Revenue.count({ where: { ...where, user_id: demo.id, date: yearRange } }),
    Cash.count({ where: { ...where, user_id: demo.id, as_at_date: yearRange } }),
  ]);
  return e + r + c > 0;
}

const sumOf = (rows, key) => {
  const vals = rows.map((r) => r[key]).filter((v) => v !== null);
  return vals.length ? round2(vals.reduce((a, b) => a + b, 0)) : null;
};

export async function getExecutiveData({ organization, period }) {
  const [expSeries, igfSeries, cash, budget, ytdSource, contrib, unverified, illustrative, years] = await Promise.all([
    monthlySums(BudgetExpenditure, "date", ["actualExpenditure", "actualPayment"], organization, period),
    monthlySums(Revenue, "date", ["actual_collection"], organization, period),
    cashByCurrency(organization, period),
    approvedBudget(organization, period.year),
    ytdBySource(organization, period),
    contributors(organization, period),
    unverifiedInMonth(organization, period),
    hasIllustrativeData(organization, period),
    availableYears(organization),
  ]);

  const econMonthly = await monthlyByEconomic(organization, period);
  const expenditure = expSeries.map((r, i) => ({
    month: r.month,
    records: r.records,
    expenditure: r.actualExpenditure,
    payments: r.actualPayment,
    breakdown: r.records ? econMonthly[i + 1] || [] : [],
  }));
  const igf = igfSeries.map((r) => ({ month: r.month, records: r.records, collections: r.actual_collection }));
  const current = expenditure[period.month - 1];
  const currentIgf = igf[period.month - 1];

  const ytdExpenditure = sumOf(expenditure, "expenditure");
  const ytdPayments = sumOf(expenditure, "payments");
  const ytdIgf = sumOf(igf, "collections");

  const funding = FUNDS.map(({ key, label }) => {
    const approved = budget.bySource[key] ?? null;
    const actual = ytdSource[key] ?? 0;
    return {
      key,
      label,
      approved,
      actual,
      utilisationPct: approved > 0 ? round2((actual / approved) * 100) : null,
    };
  });

  return {
    period,
    years: years.includes(period.year) ? years : [period.year, ...years].sort((a, b) => b - a),
    kpis: {
      approvedBudget: budget.total,
      budgetLines: budget.lines,
      monthExpenditure: current?.records ? current.expenditure : null,
      monthPayments: current?.records ? current.payments : null,
      monthIgf: currentIgf?.records ? currentIgf.collections : null,
      ytdExpenditure,
      ytdPayments,
      ytdIgf,
      budgetUtilisationPct:
        budget.total > 0 && ytdExpenditure !== null ? round2((ytdExpenditure / budget.total) * 100) : null,
      // Payments and expenditure over the same Jan..month window.
      paymentCoveragePct:
        ytdExpenditure > 0 && ytdPayments !== null ? round2((ytdPayments / ytdExpenditure) * 100) : null,
    },
    series: { expenditure, igf },
    cash,
    funding,
    contributors: contrib,
    unverified,
    illustrative,
  };
}

// ---------------------------------------------------------------------------
// Expenditure Analysis (drill-down from the dashboard's Expenditure Trend)
// ---------------------------------------------------------------------------
const ECONOMIC = [
  { key: "Compensation of Employees", short: "COE" },
  { key: "Goods and Services", short: "G&S" },
  { key: "Capital Expenditure", short: "CAPEX" },
];
const econKey = (raw) => {
  const match = ECONOMIC.find((e) => e.key.toLowerCase() === String(raw || "").trim().toLowerCase());
  return match ? match.key : "Others";
};
const FUND_KEYS = FUNDS.map((f) => f.key);
export const normaliseSource = (value) => {
  const v = String(value || "").toUpperCase();
  return FUND_KEYS.includes(v) ? v : null;
};

/** Top 5 by amount with share of the whole (YTD). */
async function topYtd(field, organization, period, sourceWhere) {
  const rows = await BudgetExpenditure.findAll({
    attributes: [[col(field), "name"], [fn("SUM", col("actualExpenditure")), "amount"]],
    where: {
      ...orgWhere(organization),
      ...sourceWhere,
      status: "Approved",
      date: { [Op.between]: [period.start, period.end] },
    },
    group: [col(field)],
    raw: true,
  });
  const total = rows.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const items = rows
    .map((r) => ({ name: r.name || "Unspecified", amount: round2(r.amount) }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map((r) => ({ ...r, share: total > 0 ? round2((r.amount / total) * 100) : null }));
  return { total: round2(total), top: items };
}

export async function getExpenditureAnalysis({ organization, period, source }) {
  const sourceWhere = source ? { sourceOfFunding: source } : {};
  const ytdRange = { [Op.between]: [period.start, period.end] };
  const [series, budgetRows, actualRows, departments, naturalAccounts, unverified, illustrative, years] =
    await Promise.all([
      monthlySums(BudgetExpenditure, "date", ["actualExpenditure", "actualPayment"], organization, period, sourceWhere),
      LoadedData.findAll({
        attributes: ["economicClassification", "sourceOfFunding", [fn("SUM", col("appropriation")), "total"]],
        where: { ...orgWhere(organization), ...sourceWhere, year: period.year },
        group: ["economicClassification", "sourceOfFunding"],
        raw: true,
      }),
      BudgetExpenditure.findAll({
        attributes: [
          "economicClassification",
          "sourceOfFunding",
          [fn("SUM", col("actualExpenditure")), "spent"],
          [fn("SUM", col("actualPayment")), "paid"],
        ],
        where: { ...orgWhere(organization), ...sourceWhere, status: "Approved", date: ytdRange },
        group: ["economicClassification", "sourceOfFunding"],
        raw: true,
      }),
      topYtd(organization ? "activity" : "organization", organization, period, sourceWhere),
      topYtd("naturalAccount", organization, period, sourceWhere),
      unverifiedInMonth(organization, period),
      hasIllustrativeData(organization, period),
      availableYears(organization),
    ]);

  // Economic classification and funding source tables.
  const econ = Object.fromEntries(
    [...ECONOMIC.map((e) => e.key), "Others"].map((k) => [k, { approved: 0, actual: 0, payments: 0 }]),
  );
  const fund = Object.fromEntries(FUND_KEYS.map((k) => [k, { approved: 0, actual: 0 }]));
  budgetRows.forEach((r) => {
    const amount = Number(r.total) || 0;
    econ[econKey(r.economicClassification)].approved += amount;
    const f = String(r.sourceOfFunding || "").toUpperCase();
    if (fund[f]) fund[f].approved += amount;
  });
  actualRows.forEach((r) => {
    const spent = Number(r.spent) || 0;
    const e = econ[econKey(r.economicClassification)];
    e.actual += spent;
    e.payments += Number(r.paid) || 0;
    const f = String(r.sourceOfFunding || "").toUpperCase();
    if (fund[f]) fund[f].actual += spent;
  });

  const row = (approved, actual, payments) => ({
    approved: round2(approved),
    actual: round2(actual),
    payments: round2(payments),
    unutilised: round2(approved - actual),
    utilisationPct: approved > 0 ? round2((actual / approved) * 100) : null,
    paymentRatePct: actual > 0 ? round2((payments / actual) * 100) : null,
  });
  const totals = Object.values(econ).reduce(
    (a, e) => ({ approved: a.approved + e.approved, actual: a.actual + e.actual, payments: a.payments + e.payments }),
    { approved: 0, actual: 0, payments: 0 },
  );
  const economic = [...ECONOMIC, { key: "Others", short: "Others" }]
    .map((e) => ({
      key: e.key,
      short: e.short,
      label: e.key === "Others" ? "Others" : `${e.key} (${e.short})`,
      ...row(econ[e.key].approved, econ[e.key].actual, econ[e.key].payments),
      share: totals.actual > 0 ? round2((econ[e.key].actual / totals.actual) * 100) : null,
    }))
    // "Others" only when something falls outside the three standard classes.
    .filter((e) => e.key !== "Others" || e.approved || e.actual);

  const econMonthly = await monthlyByEconomic(organization, period, sourceWhere);
  const expenditure = series.map((r, i) => ({
    month: r.month,
    records: r.records,
    expenditure: r.actualExpenditure,
    payments: r.actualPayment,
    breakdown: r.records ? econMonthly[i + 1] || [] : [],
  }));
  const current = expenditure[period.month - 1];
  const prev = expenditure[period.month - 2];
  const totalRow = row(totals.approved, totals.actual, totals.payments);

  return {
    period,
    years: years.includes(period.year) ? years : [period.year, ...years].sort((a, b) => b - a),
    source,
    kpis: {
      approvedBudget: totalRow.approved,
      ytdExpenditure: totalRow.actual,
      ytdPayments: totalRow.payments,
      unutilised: totalRow.unutilised,
      utilisationPct: totalRow.utilisationPct,
      paymentRatePct: totalRow.paymentRatePct,
      unutilisedPct: totals.approved > 0 ? round2((totalRow.unutilised / totals.approved) * 100) : null,
      monthExpenditure: current?.records ? current.expenditure : null,
      previousMonthExpenditure: prev?.records ? prev.expenditure : null,
    },
    series: { expenditure },
    economic,
    total: totalRow,
    funding: FUNDS.filter((f) => !source || f.key === source).map(({ key, label }) => {
      const { approved, actual, unutilised, utilisationPct } = row(fund[key].approved, fund[key].actual, 0);
      return { key, label, approved, actual, unutilised, utilisationPct };
    }),
    contributors: {
      groupBy: organization ? "activity" : "DAD",
      departments,
      naturalAccounts,
    },
    unverified,
    illustrative,
  };
}

/**
 * Approved expenditure per month split by economic classification:
 * { 1: [{ key, short, amount }, ...], 2: [...] } in COE, G&S, CAPEX, Others order.
 */
async function monthlyByEconomic(organization, period, extraWhere = {}) {
  const rows = await BudgetExpenditure.findAll({
    attributes: [
      [fn("MONTH", col("date")), "m"],
      "economicClassification",
      [fn("SUM", col("actualExpenditure")), "amount"],
    ],
    where: {
      ...orgWhere(organization),
      ...extraWhere,
      status: "Approved",
      date: { [Op.between]: [period.start, period.end] },
    },
    group: [fn("MONTH", col("date")), "economicClassification"],
    raw: true,
  });
  const order = [...ECONOMIC, { key: "Others", short: "Others" }];
  const byMonth = {};
  rows.forEach((r) => {
    const m = Number(r.m);
    const key = econKey(r.economicClassification);
    byMonth[m] ??= {};
    byMonth[m][key] = (byMonth[m][key] || 0) + (Number(r.amount) || 0);
  });
  return Object.fromEntries(
    Object.entries(byMonth).map(([m, sums]) => [
      m,
      order.filter((e) => sums[e.key]).map((e) => ({ key: e.key, short: e.short, amount: round2(sums[e.key]) })),
    ]),
  );
}
