// Period parsing for the Analytics dashboard (moved unchanged from analytics.service.js).
const QUARTER_BOUNDS = {
  1: { startSuffix: "01-01", endSuffix: "03-31" },
  2: { startSuffix: "04-01", endSuffix: "06-30" },
  3: { startSuffix: "07-01", endSuffix: "09-30" },
  4: { startSuffix: "10-01", endSuffix: "12-31" },
};

const quarterBounds = (year, quarter) => ({
  start: `${year}-${QUARTER_BOUNDS[quarter].startSuffix}`,
  end: `${year}-${QUARTER_BOUNDS[quarter].endSuffix}`,
});

const previousQuarter = (year, quarter) =>
  quarter === 1
    ? { year: year - 1, quarter: 4 }
    : { year, quarter: quarter - 1 };

const PERIOD_YEAR_MIN = 2000;
const PERIOD_YEAR_MAX = 2100;

function invalidPeriod() {
  const error = new Error(
    "Invalid period. Choose a year from 2000 to 2100 and an optional quarter (1–4).",
  );
  error.statusCode = 400;
  throw error;
}

export function buildPeriod(year, quarters) {
  const start = quarterBounds(year, quarters[0]).start;
  const end = quarterBounds(year, quarters[quarters.length - 1]).end;

  let prevYear;
  let prevQuarters;
  if (quarters.length === 1) {
    const prev = previousQuarter(year, quarters[0]);
    prevYear = prev.year;
    prevQuarters = [prev.quarter];
  } else {
    prevYear = year - 1;
    prevQuarters = [...quarters];
  }

  return {
    year,
    quarters,
    start,
    end,
    prevYear,
    prevQuarters,
    prevStart: quarterBounds(prevYear, prevQuarters[0]).start,
    prevEnd: quarterBounds(prevYear, prevQuarters[prevQuarters.length - 1]).end,
  };
}

function yearToDateQuarters(currentQuarter) {
  return Array.from({ length: currentQuarter }, (_, i) => i + 1);
}

function parseYear(year) {
  const yearNum = Number(String(year).trim());
  if (
    !Number.isInteger(yearNum) ||
    yearNum < PERIOD_YEAR_MIN ||
    yearNum > PERIOD_YEAR_MAX
  ) {
    invalidPeriod();
  }
  return yearNum;
}

// Older clients sent one period string. Keep that path so those requests still resolve.
function parsePeriodString(period, currentYear, currentQuarter) {
  if (!period || String(period).trim().toUpperCase() === "YTD") {
    return buildPeriod(currentYear, yearToDateQuarters(currentQuarter));
  }

  const str = String(period).trim();

  const yearOnly = str.match(/^(\d{4})$/);
  if (yearOnly) {
    return buildPeriod(parseYear(yearOnly[1]), [1, 2, 3, 4]);
  }

  const qOnly = str.match(/^(?:Q)?([1-4])$/i);
  if (qOnly) {
    return buildPeriod(currentYear, [Number(qOnly[1])]);
  }

  const qThenYear = str.match(/^Q([1-4])[\s\-\/]+(\d{4})$/i);
  if (qThenYear) {
    return buildPeriod(parseYear(qThenYear[2]), [Number(qThenYear[1])]);
  }

  const yearThenQ = str.match(/^(\d{4})[\s\-\/]+Q([1-4])$/i);
  if (yearThenQ) {
    return buildPeriod(parseYear(yearThenQ[1]), [Number(yearThenQ[2])]);
  }

  invalidPeriod();
}

export function parseDashboardPeriod(input) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentQuarter = Math.floor(now.getMonth() / 3) + 1;

  if (typeof input === "string" || input == null || typeof input === "number") {
    return parsePeriodString(input, currentYear, currentQuarter);
  }

  const { year, quarter, period } = input;
  const yearBlank =
    year === undefined || year === null || String(year).trim() === "";
  const quarterText =
    quarter === undefined || quarter === null ? "" : String(quarter).trim();
  const quarterBlank =
    !quarterText || quarterText.toUpperCase() === "ALL";

  if (yearBlank && quarterBlank) {
    if (period) return parsePeriodString(period, currentYear, currentQuarter);
    return buildPeriod(currentYear, yearToDateQuarters(currentQuarter));
  }

  const resolvedYear = yearBlank ? currentYear : parseYear(year);

  if (quarterBlank) {
    return buildPeriod(resolvedYear, [1, 2, 3, 4]);
  }

  if (quarterText.toUpperCase() === "YTD") {
    if (resolvedYear === currentYear) {
      return buildPeriod(currentYear, yearToDateQuarters(currentQuarter));
    }
    // A closed year has no partial "to date" window. Return the whole year.
    return buildPeriod(resolvedYear, [1, 2, 3, 4]);
  }

  const quarterMatch = quarterText.match(/^Q?([1-4])$/i);
  if (!quarterMatch) invalidPeriod();
  return buildPeriod(resolvedYear, [Number(quarterMatch[1])]);
}
