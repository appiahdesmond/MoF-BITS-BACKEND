// Retention rates over time. Each change in retention_rate_changes takes effect from
// its effective_date; the rate for any day is the latest change effective on or
// before that day. Before an organisation's first recorded change, its first rate
// applies (the change's old rate, or its new rate when it was the initial rate).
import { Op } from "sequelize";
import { RetentionRateChange } from "../models/organization.model.js";

/** Today as YYYY-MM-DD in local time. */
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const day = (value) => String(value ?? "").slice(0, 10);

/**
 * Rate periods for one organisation, oldest first: [{ from, rate }] where the first
 * period has from = null (applies to any earlier date).
 * `changes` are that organisation's RetentionRateChange rows; `fallback` is the
 * stored rate, used when there is no history at all.
 */
export function ratePeriods(changes, fallback) {
  if (!changes.length) return fallback === null || fallback === undefined ? [] : [{ from: null, rate: fallback }];
  const sorted = [...changes].sort(
    (a, b) => day(a.effective_date).localeCompare(day(b.effective_date)) || a.id - b.id,
  );
  const first = sorted[0];
  const base = first.old_rate ?? first.new_rate;
  return [
    { from: null, rate: base },
    ...sorted.map((c) => ({ from: day(c.effective_date), rate: c.new_rate })),
  ];
}

/** The rate in force on `date` (YYYY-MM-DD), or null when none is configured. */
export function rateOn(periods, date) {
  let rate = null;
  for (const period of periods) {
    if (period.from === null || period.from <= day(date)) rate = period.rate;
  }
  return rate;
}

/** History rows for the given organisations, grouped by organisation id. */
export async function changesByOrganization(organizationIds) {
  const where = organizationIds ? { organization_id: { [Op.in]: organizationIds } } : {};
  const rows = await RetentionRateChange.findAll({
    where,
    attributes: ["id", "organization_id", "old_rate", "new_rate", "effective_date"],
  });
  const grouped = {};
  rows.forEach((r) => (grouped[r.organization_id] ??= []).push(r));
  return grouped;
}

/** The rate for one organisation on one date. */
export async function retentionRateOn(org, date) {
  const changes = (await changesByOrganization([org.id]))[org.id] || [];
  return rateOn(ratePeriods(changes, org.retention_rate), date);
}
