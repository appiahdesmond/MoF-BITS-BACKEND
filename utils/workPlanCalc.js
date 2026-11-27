// Work Plan costing rules, shared by every save, total and validation on the server.
// The client keeps an identical copy (src/pages/workPlan/workPlanCalc.js) for live totals;
// the server always recalculates and its figures are the ones stored.

// Funding sources for the Work Plan. FLG (Foreign Loans and Grants) replaces DPF, so costing
// maps straight onto the budget ceiling classifications (decision of 27 Nov 2026).
export const FUNDING_SOURCES = [
  { code: "GOG", label: "Government of Ghana" },
  { code: "IGF", label: "Internally Generated Funds" },
  { code: "FLG", label: "Foreign Loans and Grants" },
];

// Costing methods: which cost drivers apply. Amount = quantity × unit cost × frequency,
// except percentage-based (base amount × rate ÷ 100). Missing drivers count as 1.
export const COSTING_METHODS = {
  quantity: { label: "Quantity-based", drivers: ["quantity", "unitCost", "frequency"] },
  frequency: { label: "Frequency-based", drivers: ["quantity", "unitCost", "frequency"] },
  personnel: { label: "Personnel-based", drivers: ["quantity", "unitCost", "frequency"] },
  contract: { label: "Contract-based", drivers: ["unitCost"] },
  fixed: { label: "Fixed cost", drivers: ["unitCost"] },
  percentage: { label: "Percentage-based", drivers: ["unitCost", "quantity"] },
};

const scaled = (v, places) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return BigInt(Math.round(n * 10 ** places));
};

/** Estimated cost in pesewas, exactly (integer arithmetic, half-up). null when drivers are missing. */
export function itemCents({ costingMethod = "quantity", quantity, unitCost, frequency }) {
  const method = COSTING_METHODS[costingMethod] ?? COSTING_METHODS.quantity;
  const uc = scaled(unitCost, 2); // pesewas
  const q = method.drivers.includes("quantity") ? scaled(quantity, 4) : 10000n;
  const f = method.drivers.includes("frequency") ? scaled(frequency ?? 1, 4) : 10000n;
  if ([uc, q, f].some((x) => x === null || (typeof x === "number" && Number.isNaN(x)))) return null;
  let num = uc * q * f;
  let den = 10000n * 10000n;
  if (costingMethod === "percentage") den *= 100n;
  return Number((num * 2n + den) / (2n * den));
}

/** Validation of the whole plan before it is handed on. Each problem names its record. */
export function validateTree({ outputs, accounts, objectives, year }) {
  const errors = [];
  const accountOk = (id) => {
    const a = accounts.get(id);
    return a && a.status === "active" && a.is_posting && (!a.valid_from_year || a.valid_from_year <= year) && (!a.valid_to_year || a.valid_to_year >= year);
  };
  const objectiveOk = (id) => {
    const o = objectives.get(id);
    return o && o.status === "active" && (!o.valid_from_year || o.valid_from_year <= year) && (!o.valid_to_year || o.valid_to_year >= year);
  };
  if (!outputs.length) errors.push({ code: "noOutputs", message: "The work plan has no Main Outputs" });
  for (const o of outputs) {
    const out = (o.output || "Untitled output").slice(0, 80);
    const at = { outputId: o.id };
    if (!objectiveOk(o.objectiveId)) errors.push({ ...at, code: "objective", message: `${out}: choose a valid Adopted Objective` });
    if (!o.output?.trim()) errors.push({ ...at, code: "output", message: "A Main Output has no description" });
    if (!o.meansOfVerification?.trim()) errors.push({ ...at, code: "mov", message: `${out}: enter the Means of Verification` });
    if (!o.activities.length) errors.push({ ...at, code: "noActivities", message: `${out}: add at least one annual activity` });
    for (const a of o.activities) {
      const act = (a.description || "Untitled activity").slice(0, 80);
      const at2 = { ...at, activityId: a.id };
      if (!a.description?.trim()) errors.push({ ...at2, code: "activity", message: `${out}: an annual activity has no description` });
      if (!a.quarters.length) errors.push({ ...at2, code: "noSchedule", message: `${act}: schedule at least one quarterly activity` });
      for (const q of a.quarters) {
        const at3 = { ...at2, quarter: q.quarter, quarterActivityId: q.id };
        const where = `${act} · Q${q.quarter}`;
        if (!q.description?.trim()) errors.push({ ...at3, code: "quarterActivity", message: `${where}: a quarterly activity has no description` });
        if (!q.items.length && !q.noCost) errors.push({ ...at3, code: "notCosted", message: `${where}: cost the activity or mark it as requiring no additional cost` });
        q.items.forEach((i, n) => {
          const at4 = { ...at3, itemId: i.id };
          const item = `${where} · cost item ${n + 1}${i.description ? ` (${i.description.slice(0, 40)})` : ""}`;
          if (!i.naturalAccountId) errors.push({ ...at4, code: "account", message: `${item}: choose a Natural Account` });
          else if (!accountOk(i.naturalAccountId)) errors.push({ ...at4, code: "account", message: `${item}: the Natural Account is not a valid posting account for FY ${year}` });
          if (!i.description?.trim()) errors.push({ ...at4, code: "description", message: `${item}: describe the cost item` });
          if (!FUNDING_SOURCES.some((f) => f.code === i.fundingSource)) errors.push({ ...at4, code: "funding", message: `${item}: choose a Funding Source` });
          const cents = itemCents(i);
          const drivers = COSTING_METHODS[i.costingMethod]?.drivers ?? COSTING_METHODS.quantity.drivers;
          const missing = drivers.some((d) => !(Number(i[d]) > 0));
          if (missing || cents === null) errors.push({ ...at4, code: "drivers", message: `${item}: complete the cost drivers` });
          else if (cents !== i.amountCents) errors.push({ ...at4, code: "reconcile", message: `${item}: the estimated cost does not reconcile with its cost drivers` });
        });
      }
    }
  }
  return { errors };
}
