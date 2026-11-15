// Pure calculation helpers for the Analytics dashboard.
// No database or framework imports, so every rule here can be unit-tested.

const DAY_MS = 86_400_000;

export const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

const toUtcDate = (isoDay) => new Date(`${isoDay}T00:00:00Z`);

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * How much of the year the selected period has "used up" so far.
 * Budgets have no phasing, so expected spend is a straight pro-rata by day:
 *   expected = annual budget x (days elapsed in period / days in year)
 * A period that is still running is counted only up to today; a future
 * period has 0 elapsed days (so nothing is "expected" yet).
 */
export function periodTiming(period, today = new Date()) {
  const start = toUtcDate(period.start);
  const end = toUtcDate(period.end);
  const todayUtc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const effectiveEnd = todayUtc < end ? todayUtc : end;
  const elapsedDays =
    effectiveEnd < start ? 0 : Math.round((effectiveEnd - start) / DAY_MS) + 1;
  const yearDays = isLeapYear(period.year) ? 366 : 365;

  return {
    elapsedDays,
    yearDays,
    expectedFraction: elapsedDays / yearDays,
    isInProgress: todayUtc < end,
  };
}

export const STATUS_RANK = {
  no_data: 0,
  no_target: 0,
  on_track: 1,
  watch: 2,
  at_risk: 3,
};

export const worstStatus = (...statuses) =>
  statuses.reduce(
    (worst, s) => ((STATUS_RANK[s] ?? 0) > (STATUS_RANK[worst] ?? 0) ? s : worst),
    "no_data",
  );

/**
 * Spending pace: actual spend against what pro-rata budget says should be spent.
 *   75%-115% of expected  -> on track
 *   50%-75% or 115%-130%  -> watch
 *   below 50% or above 130%, or spend above the appropriation -> at risk
 */
export function spendStatus({ expenditure, expected, appropriation }) {
  if (!appropriation) return "no_data";
  if (expenditure > appropriation) return "at_risk";
  if (!expected) return "no_data";
  const pace = expenditure / expected;
  if (pace < 0.5 || pace > 1.3) return "at_risk";
  if (pace < 0.75 || pace > 1.15) return "watch";
  return "on_track";
}

/** IGF attainment against the pro-rata target to date. */
export function igfStatus({ actual, target }) {
  if (!target) return "no_target";
  const attainment = actual / target;
  if (attainment < 0.7) return "at_risk";
  if (attainment < 0.9) return "watch";
  return "on_track";
}

/** null when there is nothing to compare against (avoids "19351%" style noise). */
export function percentChange(current, previous) {
  if (!previous) return null;
  return round2(((current - previous) / Math.abs(previous)) * 100);
}

export const safePct = (part, whole) =>
  whole ? round1((part / whole) * 100) : null;

/**
 * Cash runway in months of current spending.
 * burn is measured over the elapsed part of the period, in 30.44-day months.
 */
export function monthsOfCover({ cash, expenditure, elapsedDays }) {
  if (!elapsedDays || !expenditure || expenditure <= 0) return null;
  const monthlyBurn = (expenditure / elapsedDays) * 30.44;
  if (!monthlyBurn) return null;
  return {
    monthlyBurn: round2(monthlyBurn),
    months: round1(cash / monthlyBurn),
  };
}

/**
 * Per-DAD (or per-classification) performance row.
 * `igf` fields are optional; classification rows pass none.
 */
export function buildPerformanceRow({
  key,
  appropriation = 0,
  allotment = 0,
  releases = 0,
  expenditure = 0,
  payment = 0,
  igfActual = 0,
  igfTarget = 0,
  retention = 0,
  remitted = 0,
  expectedFraction,
}) {
  const expected = appropriation * expectedFraction;
  const spend = spendStatus({ expenditure, expected, appropriation });
  const igf = igfStatus({ actual: igfActual, target: igfTarget });

  return {
    key,
    appropriation: round2(appropriation),
    allotment: round2(allotment),
    releases: round2(releases),
    expenditure: round2(expenditure),
    payment: round2(payment),
    unpaid: round2(expenditure - payment),
    expectedSpend: round2(expected),
    utilisationPct: safePct(expenditure, appropriation),
    expectedPct: round1(expectedFraction * 100),
    pacePct: expected ? round1((expenditure / expected) * 100) : null,
    releaseRatePct: safePct(releases, allotment),
    igfActual: round2(igfActual),
    igfTarget: round2(igfTarget),
    igfAttainmentPct: igfTarget ? round1((igfActual / igfTarget) * 100) : null,
    retention: round2(retention),
    remitted: round2(remitted),
    spendStatus: spend,
    igfStatus: igf,
    status: worstStatus(spend, igf),
  };
}

const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

/**
 * Rule-based alerts. Each alert has a stable `code`, so the UI can group or
 * filter them, and a plain sentence the reader can act on.
 */
export function buildAlerts({ rows, liquidity, pending }) {
  const alerts = [];
  const add = (severity, code, organization, message) =>
    alerts.push({ severity, code, organization: organization || null, message });

  for (const r of rows) {
    const org = r.organization ?? r.key;

    if (!r.appropriation && r.expenditure > 0) {
      add("warning", "no_appropriation", org, "Spending recorded but no appropriation is loaded.");
    } else if (r.appropriation && r.expenditure > r.appropriation) {
      add(
        "critical",
        "over_budget",
        org,
        `Spending is ${r.utilisationPct}% of the appropriation (over budget).`,
      );
    } else if (r.spendStatus === "at_risk" && r.pacePct !== null) {
      add(
        "critical",
        r.pacePct < 100 ? "underspend" : "overspend_pace",
        org,
        r.pacePct < 100
          ? `Spending is only ${r.pacePct}% of the expected pace for this period.`
          : `Spending is running at ${r.pacePct}% of the expected pace.`,
      );
    } else if (r.spendStatus === "watch" && r.pacePct !== null) {
      add(
        "warning",
        r.pacePct < 100 ? "underspend" : "overspend_pace",
        org,
        r.pacePct < 100
          ? `Spending is behind pace (${r.pacePct}% of expected).`
          : `Spending is ahead of pace (${r.pacePct}% of expected).`,
      );
    }

    if (r.igfStatus === "at_risk" || r.igfStatus === "watch") {
      add(
        r.igfStatus === "at_risk" ? "critical" : "warning",
        "igf_below_target",
        org,
        `IGF collected is ${r.igfAttainmentPct}% of the target to date.`,
      );
    }

    if (r.releases > 0 && r.expenditure > r.releases) {
      add("warning", "spend_above_releases", org, "Expenditure is higher than funds released.");
    }

    if (r.expenditure > 0 && r.unpaid / r.expenditure > 0.3) {
      add(
        "warning",
        "unpaid_commitments",
        org,
        `${round1((r.unpaid / r.expenditure) * 100)}% of expenditure has not been paid.`,
      );
    }
  }

  if (liquidity?.months !== null && liquidity?.months !== undefined && liquidity.months < 1) {
    add(
      "critical",
      "low_cash_cover",
      null,
      `GHS cash covers about ${liquidity.months} month of current spending.`,
    );
  }

  if (pending?.count > 0) {
    add(
      "info",
      "pending_approval",
      null,
      `${pending.count} record${pending.count === 1 ? "" : "s"} in this view ${
        pending.count === 1 ? "is" : "are"
      } not yet approved. Switch Data status to "Approved" to see confirmed figures only.`,
    );
  }

  alerts.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      String(a.organization).localeCompare(String(b.organization)),
  );

  return {
    total: alerts.length,
    counts: {
      critical: alerts.filter((a) => a.severity === "critical").length,
      warning: alerts.filter((a) => a.severity === "warning").length,
      info: alerts.filter((a) => a.severity === "info").length,
    },
    items: alerts.slice(0, 20),
  };
}

/**
 * Pick one number per (organization, category) for the annual IGF target.
 * Targets are typed in by hand on each revenue record, so we do not know if
 * a record carries the whole-year target or only its own slice:
 *   "latest" - the most recent non-zero entry wins (whole-year target repeated)
 *   "sum"    - every entry is a separate slice and they add up
 * Rows must arrive newest first.
 */
export function resolveIgfTargets(rows, mode = "latest") {
  const byPair = new Map();
  for (const row of rows) {
    const amount = Number(row.budgetProjections) || 0;
    if (!amount) continue;
    const key = `${row.organization}||${row.category}`;
    if (mode === "sum") {
      byPair.set(key, (byPair.get(key) || 0) + amount);
    } else if (!byPair.has(key)) {
      byPair.set(key, amount);
    }
  }

  const byOrg = {};
  const byCategory = {};
  for (const [key, amount] of byPair) {
    const [org, category] = key.split("||");
    byOrg[org] = (byOrg[org] || 0) + amount;
    byCategory[category] = (byCategory[category] || 0) + amount;
  }
  return { byOrg, byCategory };
}

export function buildInsights({ summary, liquidity, igf }) {
  const execution =
    summary.pacePct === null
      ? "No appropriation or spending pace can be calculated for this selection."
      : `Spending is ${summary.pacePct}% of the pro-rata budget for the period, ${summary.budgetUtilisationPct}% of the full-year appropriation.`;

  const igfLine =
    igf.attainmentPct === null
      ? "No IGF targets (budget projections) are entered for this selection."
      : `IGF collected is ${igf.attainmentPct}% of the target to date.`;

  const cash =
    liquidity.months === null
      ? "Cash cover cannot be worked out until there is recorded spending."
      : `GHS cash covers about ${liquidity.months} months of current spending.`;

  return { execution, igf: igfLine, liquidity: cash };
}
