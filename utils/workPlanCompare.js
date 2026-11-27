// Compare two versions of a Work Plan tree (Initial vs Revised, or two submitted versions).
// Records are matched by identity: a Revised record carries origin_id (the Initial record it
// came from); records added during revision keep their own id across Revised versions.
// Every record gets one primary type (Retained, Revised, Added, Removed, Deferred) for
// counting, plus attributes (Rescheduled, Reclassified), field-level changes and the
// financial difference, which reconcile up the hierarchy.

const LEVELS = ["output", "activity", "quarter", "item"];
const CHILD = { output: "activities", activity: "quarters", quarter: "items" };
const FIELDS = {
  output: [["output", "Main Output"], ["meansOfVerification", "Means of Verification"], ["objectiveId", "Adopted Objective"]],
  activity: [["description", "Description"]],
  quarter: [["description", "Description"], ["quarter", "Quarter"], ["noCost", "No additional cost"]],
  item: [
    ["description", "Cost item"],
    ["naturalAccountId", "Natural Account"],
    ["fundingSource", "Funding Source"],
    ["unitOfMeasure", "Unit of Measure"],
    ["costingMethod", "Costing method"],
    ["quantity", "Quantity"],
    ["unitCost", "Unit Cost"],
    ["frequency", "Frequency"],
  ],
};

const norm = (v) => (v === undefined || v === "" ? null : typeof v === "number" ? Number(v) : v);
const key = (rec, kind) => (kind === "initial" ? `o${rec.id}` : rec.originId ? `o${rec.originId}` : `n${rec.id}`);
const cents = (level, rec) => (level === "item" ? rec.amountCents ?? 0 : (rec[CHILD[level]] ?? []).reduce((s, c) => s + cents(LEVELS[LEVELS.indexOf(level) + 1], c), 0));
const label = (level, rec) => (level === "output" ? rec.output : rec.description) || "";

/**
 * @param base  { kind: "initial"|"revised", outputs }
 * @param target { kind, outputs }
 * @param ctx   { accounts: Map(id → { economic_classification }), decisions: Map("type:originId" → decision) }
 */
export function compareTrees(base, target, ctx = {}) {
  const accountClass = (id) => ctx.accounts?.get(id)?.economic_classification ?? null;
  const decisions = ctx.decisions ?? new Map();
  function walk(level, bList, tList, inherited) {
    const bMap = new Map((bList ?? []).map((r) => [key(r, base.kind), r]));
    const tMap = new Map((tList ?? []).map((r) => [key(r, target.kind), r]));
    const keys = [...new Set([...tMap.keys(), ...bMap.keys()])];
    return keys.map((k) => {
      const b = bMap.get(k) ?? null;
      const t = tMap.get(k) ?? null;
      const childLevel = LEVELS[LEVELS.indexOf(level) + 1];
      const decision = !t && b ? (inherited ?? decisions.get(`${level}:${k.slice(1)}`)?.decision ?? null) : null;
      const children = childLevel ? walk(childLevel, b?.[CHILD[level]], t?.[CHILD[level]], decision === "deferred" ? "deferred" : decision === "removed" ? "removed" : null) : [];
      const changes = [];
      const attrs = [];
      if (b && t)
        for (const [f, name] of FIELDS[level]) {
          const from = norm(b[f]);
          const to = norm(t[f]);
          if (from !== to) changes.push({ field: f, name, from, to });
        }
      if (level === "quarter" && changes.some((c) => c.field === "quarter")) attrs.push("Rescheduled");
      if (level === "item" && b && t && (b.fundingSource !== t.fundingSource || accountClass(b.naturalAccountId) !== accountClass(t.naturalAccountId) || b.naturalAccountId !== t.naturalAccountId)) attrs.push("Reclassified");
      for (const c of children) for (const a of c.attrs) if (!attrs.includes(a)) attrs.push(a);
      const baseCents = b ? cents(level, b) : 0;
      const targetCents = t ? cents(level, t) : 0;
      let type;
      if (!b) type = "Added";
      else if (!t) type = decision === "deferred" ? "Deferred" : "Removed";
      else type = changes.length || baseCents !== targetCents || children.some((c) => c.type !== "Retained") ? "Revised" : "Retained";
      return {
        level,
        key: k,
        id: t?.id ?? null,
        originId: b?.id ?? (t?.originId || null),
        baseLabel: b ? label(level, b) : null,
        targetLabel: t ? label(level, t) : null,
        quarter: level === "quarter" ? (t ?? b).quarter : undefined,
        base: level === "item" && b ? { ...b } : undefined,
        target: level === "item" && t ? { ...t } : undefined,
        type,
        attrs,
        changes,
        baseCents,
        targetCents,
        diffCents: targetCents - baseCents,
        reason: level === "activity" ? (t?.revisionReason ?? (!t ? decisions.get(`activity:${k.slice(1)}`)?.reason : null) ?? null) : level === "item" ? (t?.revisionReason ?? null) : !t ? (decisions.get(`${level}:${k.slice(1)}`)?.reason ?? null) : null,
        updatedBy: t?.updatedBy ?? null,
        updatedAt: t?.updatedAt ?? null,
        children,
      };
    });
  }
  const tree = walk("output", base.outputs, target.outputs, null);
  const counts = Object.fromEntries(LEVELS.map((l) => [l, { initial: 0, retained: 0, revised: 0, added: 0, removed: 0, deferred: 0, included: 0, rescheduled: 0, reclassified: 0 }]));
  const visit = (n) => {
    const c = counts[n.level];
    if (n.type !== "Added") c.initial += 1;
    if (!["Removed", "Deferred"].includes(n.type)) c.included += 1;
    c[n.type.toLowerCase()] += 1;
    if (n.level === "quarter" && n.changes.some((x) => x.field === "quarter")) c.rescheduled += 1;
    if (n.level === "item" && n.attrs.includes("Reclassified")) c.reclassified += 1;
    n.children.forEach(visit);
  };
  tree.forEach(visit);
  const baseCents = tree.reduce((s, n) => s + n.baseCents, 0);
  const targetCents = tree.reduce((s, n) => s + n.targetCents, 0);
  return { tree, counts, baseCents, targetCents, diffCents: targetCents - baseCents };
}
