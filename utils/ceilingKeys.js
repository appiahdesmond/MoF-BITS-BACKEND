// The eight ceiling classifications (funding source × economic classification). FLG has no
// Compensation of Employees ceiling. Shared by the Budget Ceilings and Work Plan services.
export const CEILING_KEYS = ["gog_coe", "gog_gs", "gog_capex", "igf_coe", "igf_gs", "igf_capex", "flg_gs", "flg_capex"];
export const FUNDS = [
  { code: "GOG", label: "GoG", keys: ["gog_coe", "gog_gs", "gog_capex"] },
  { code: "IGF", label: "IGF", keys: ["igf_coe", "igf_gs", "igf_capex"] },
  { code: "FLG", label: "FLG", keys: ["flg_gs", "flg_capex"] },
];
const CLASS_CODE = { "Compensation of Employees": "coe", "Goods and Services": "gs", "Capital Expenditure": "capex" };
export const KEY_LABEL = {
  gog_coe: "GoG · Compensation of Employees",
  gog_gs: "GoG · Goods and Services",
  gog_capex: "GoG · Capital Expenditure",
  igf_coe: "IGF · Compensation of Employees",
  igf_gs: "IGF · Goods and Services",
  igf_capex: "IGF · Capital Expenditure",
  flg_gs: "FLG · Goods and Services",
  flg_capex: "FLG · Capital Expenditure",
};
/** Ceiling key for a funding source and economic classification, or null (e.g. FLG COE). */
export function ceilingKey(fund, economicClassification) {
  const k = `${String(fund || "").toLowerCase()}_${CLASS_CODE[economicClassification] ?? ""}`;
  return CEILING_KEYS.includes(k) ? k : null;
}
export const toCents = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
export const centsRow = (row) => Object.fromEntries(CEILING_KEYS.map((k) => [k, toCents(row?.[k])]));
