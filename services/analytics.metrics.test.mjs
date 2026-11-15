import assert from "node:assert/strict";
import {
  periodTiming,
  spendStatus,
  igfStatus,
  percentChange,
  monthsOfCover,
  buildPerformanceRow,
  buildAlerts,
  resolveIgfTargets,
  worstStatus,
} from "./analytics.metrics.js";

// Full closed year -> 100% expected
let t = periodTiming({ year: 2025, start: "2025-01-01", end: "2025-12-31" }, new Date("2026-11-15"));
assert.equal(t.elapsedDays, 365);
assert.equal(t.expectedFraction, 1);
assert.equal(t.isInProgress, false);

// In-progress year: to 15 Nov 2026 = 319 days
t = periodTiming({ year: 2026, start: "2026-01-01", end: "2026-12-31" }, new Date("2026-11-15"));
assert.equal(t.elapsedDays, 319);
assert.ok(Math.abs(t.expectedFraction - 319 / 365) < 1e-9);
assert.equal(t.isInProgress, true);

// Future quarter -> nothing expected
t = periodTiming({ year: 2027, start: "2027-01-01", end: "2027-03-31" }, new Date("2026-11-15"));
assert.equal(t.elapsedDays, 0);

// Q1 closed, leap year
t = periodTiming({ year: 2024, start: "2024-01-01", end: "2024-03-31" }, new Date("2026-11-15"));
assert.equal(t.elapsedDays, 91);
assert.equal(t.yearDays, 366);

// Spend status
assert.equal(spendStatus({ expenditure: 0, expected: 0, appropriation: 0 }), "no_data");
assert.equal(spendStatus({ expenditure: 10, expected: 100, appropriation: 400 }), "at_risk");
assert.equal(spendStatus({ expenditure: 60, expected: 100, appropriation: 400 }), "watch");
assert.equal(spendStatus({ expenditure: 100, expected: 100, appropriation: 400 }), "on_track");
assert.equal(spendStatus({ expenditure: 120, expected: 100, appropriation: 400 }), "watch");
assert.equal(spendStatus({ expenditure: 140, expected: 100, appropriation: 400 }), "at_risk");
assert.equal(spendStatus({ expenditure: 500, expected: 100, appropriation: 400 }), "at_risk");

// IGF status
assert.equal(igfStatus({ actual: 5, target: 0 }), "no_target");
assert.equal(igfStatus({ actual: 60, target: 100 }), "at_risk");
assert.equal(igfStatus({ actual: 80, target: 100 }), "watch");
assert.equal(igfStatus({ actual: 95, target: 100 }), "on_track");

// Percent change: no prior data -> null, not 100 / 19351
assert.equal(percentChange(50, 0), null);
assert.equal(percentChange(150, 100), 50);
assert.equal(percentChange(50, 100), -50);

// Cash cover
assert.equal(monthsOfCover({ cash: 100, expenditure: 0, elapsedDays: 30 }), null);
const cover = monthsOfCover({ cash: 3044, expenditure: 100, elapsedDays: 30.44 });
assert.equal(cover.months, 30.4); // burn = 100/30.44*30.44 = 100 per month -> 3044/100 = 30.44
assert.equal(worstStatus("on_track", "watch", "no_data"), "watch");

// Row + alerts
const row = buildPerformanceRow({
  key: "MOH",
  appropriation: 1000,
  allotment: 800,
  releases: 100,
  expenditure: 150,
  payment: 50,
  igfActual: 40,
  igfTarget: 100,
  expectedFraction: 0.5,
});
assert.equal(row.expectedSpend, 500);
assert.equal(row.pacePct, 30);
assert.equal(row.unpaid, 100);
assert.equal(row.spendStatus, "at_risk");
assert.equal(row.igfStatus, "at_risk");
assert.equal(row.status, "at_risk");

const { key, ...rest } = row;
const alerts = buildAlerts({
  rows: [{ organization: key, ...rest }],
  liquidity: { months: 0.5 },
  pending: { count: 3 },
});
const codes = alerts.items.map((a) => a.code);
assert.ok(codes.includes("underspend"));
assert.equal(alerts.items.find((a) => a.code === "underspend").organization, "MOH");
assert.ok(codes.includes("igf_below_target"));
assert.ok(codes.includes("spend_above_releases"));
assert.ok(codes.includes("unpaid_commitments"));
assert.ok(codes.includes("low_cash_cover"));
assert.ok(codes.includes("pending_approval"));
assert.equal(alerts.items[alerts.items.length - 1].severity, "info");

// Targets: newest first; latest vs sum
const rows = [
  { organization: "A", category: "fees", budgetProjections: 1200 },
  { organization: "A", category: "fees", budgetProjections: 1000 },
  { organization: "A", category: "fines", budgetProjections: 0 },
  { organization: "B", category: "fees", budgetProjections: 300 },
];
let r = resolveIgfTargets(rows, "latest");
assert.equal(r.byOrg.A, 1200);
assert.equal(r.byCategory.fees, 1500);
r = resolveIgfTargets(rows, "sum");
assert.equal(r.byOrg.A, 2200);

console.log("analytics.metrics: all tests passed");
