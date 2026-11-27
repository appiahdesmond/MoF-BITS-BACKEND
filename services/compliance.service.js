// Reporting compliance: did each DAD submit its monthly returns, on time, and how
// far have they moved through the approval workflow?
//
// Rules (constants below, so they are easy to change):
//   • Every active DAD in the user's data scope is expected to submit IGF revenue,
//     cash position and expenditure records for each month.
//   • A month's submissions are due by the 15th of the following month.
//   • A submission is the first record of that type dated in the month; it is late
//     when that record was created after the due date.
//   • Reallocations are occasional, so they are shown but not expected.
import { Op } from "sequelize";
import Revenue from "../models/revenue.model.js";
import Cash from "../models/cash.model.js";
import BudgetExpenditure from "../models/expenditure.model.js";
import Reallocation from "../models/reallocation.model.js";
import Organization from "../models/organization.model.js";

export const DUE_DAY = 15;

const TYPES = [
  { key: "revenue", label: "IGF revenue", Model: Revenue, dateField: "date", expected: true },
  { key: "cash", label: "Cash position", Model: Cash, dateField: "as_at_date", expected: true },
  { key: "expenditure", label: "Expenditure", Model: BudgetExpenditure, dateField: "date", expected: true },
  { key: "reallocation", label: "Reallocation", Model: Reallocation, dateField: "date", expected: false },
];

const STAGE = (status) =>
  status === "Pending"
    ? "dadReview"
    : status === "Reviewed"
      ? "dadApproval"
      : status === "PendingPCMEDReview" || status === "PendingPCMEDApproval"
        ? "pcmed"
        : status === "Approved"
          ? "approved"
          : "returned";

const pad = (n) => String(n).padStart(2, "0");

/** Compliance for one month (1–12) of `year`, for the given DAD scope. */
export async function complianceFor({ year, month, scope, now = new Date() }) {
  const from = `${year}-${pad(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${pad(month)}-${pad(lastDay)}`;
  const due = new Date(month === 12 ? year + 1 : year, month % 12, DUE_DAY, 23, 59, 59);
  const isDue = now > due;

  const orgWhere = { status: "active" };
  if (!scope.all) orgWhere.name = { [Op.in]: scope.organizations };
  const dads = (await Organization.findAll({ where: orgWhere, attributes: ["name", "code"], order: [["name", "ASC"]] })).map(
    (o) => ({ name: o.name, code: o.code }),
  );
  const names = dads.map((d) => d.name);

  const byDad = Object.fromEntries(
    dads.map((d) => [
      d.name,
      {
        organization: d.name,
        code: d.code,
        types: {},
        progress: { dadReview: 0, dadApproval: 0, pcmed: 0, approved: 0, returned: 0 },
        records: 0,
      },
    ]),
  );

  for (const t of TYPES) {
    if (!names.length) break;
    const rows = await t.Model.findAll({
      where: { organization: { [Op.in]: names }, [t.dateField]: { [Op.between]: [from, to] } },
      attributes: ["organization", "status", "createdAt"],
    });
    const first = {};
    rows.forEach((r) => {
      const d = byDad[r.organization];
      if (!d) return;
      d.records += 1;
      d.progress[STAGE(r.status)] += 1;
      if (!first[r.organization] || r.createdAt < first[r.organization]) first[r.organization] = r.createdAt;
    });
    for (const name of names) {
      const submittedAt = first[name] ?? null;
      const status = submittedAt
        ? submittedAt > due
          ? "late"
          : "onTime"
        : isDue
          ? "missing"
          : "notYetDue";
      byDad[name].types[t.key] = { status, submittedAt, expected: t.expected };
    }
  }

  const rows = Object.values(byDad).map((d) => {
    const expected = TYPES.filter((t) => t.expected).map((t) => d.types[t.key]);
    const received = expected.filter((x) => x && (x.status === "onTime" || x.status === "late")).length;
    const onTime = expected.filter((x) => x?.status === "onTime").length;
    const late = expected.filter((x) => x?.status === "late").length;
    return {
      ...d,
      expected: expected.length,
      received,
      onTime,
      late,
      outstanding: expected.length - received,
      returned: d.progress.returned,
      rate: expected.length ? (onTime / expected.length) * 100 : 0,
    };
  });

  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const expected = sum("expected");
  return {
    period: { year, month, from, to, due: due.toISOString(), isDue },
    rules: { dueDay: DUE_DAY, expectedTypes: TYPES.filter((t) => t.expected).map((t) => t.label) },
    types: TYPES.map(({ key, label, expected: exp }) => ({ key, label, expected: exp })),
    totals: {
      dads: rows.length,
      expected,
      received: sum("received"),
      outstanding: sum("outstanding"),
      late: sum("late"),
      onTime: sum("onTime"),
      returned: sum("returned"),
      rate: expected ? (sum("onTime") / expected) * 100 : 0,
      progress: ["dadReview", "dadApproval", "pcmed", "approved", "returned"].reduce(
        (acc, k) => ({ ...acc, [k]: rows.reduce((a, r) => a + r.progress[k], 0) }),
        {},
      ),
    },
    rows,
  };
}
