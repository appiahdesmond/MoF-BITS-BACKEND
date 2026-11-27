import * as svc from "../services/workPlan.service.js";

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.statusCode && error.statusCode < 500)
      return res.status(error.statusCode).json({ message: error.message, code: error.code, revision: error.revision, validation: error.validation });
    next(error);
  }
};
const id = (req, key = "id") => Number(req.params[key]);

export const getReference = wrap(async (req, res) => res.json(await svc.referenceData(req.query.year)));
export const getWorkPlan = wrap(async (req, res) => res.json(await svc.getPlan(req.user, req.query)));
export const postOutput = wrap(async (req, res) => res.json(await svc.saveOutput(req.user, id(req), null, req.body || {})));
export const putOutput = wrap(async (req, res) => res.json(await svc.saveOutput(req.user, id(req), id(req, "outputId"), req.body || {})));
export const removeOutput = wrap(async (req, res) => res.json(await svc.deleteOutput(req.user, id(req), id(req, "outputId"), req.body || {})));
export const putActivity = wrap(async (req, res) => res.json(await svc.saveActivity(req.user, id(req), req.body || {})));
export const removeActivity = wrap(async (req, res) => res.json(await svc.deleteActivity(req.user, id(req), id(req, "activityId"), req.body || {})));
export const patchCostItem = wrap(async (req, res) => res.json(await svc.patchCostItem(req.user, id(req), id(req, "itemId"), req.body || {})));
export const postStep = (action) => wrap(async (req, res) => res.json(await svc.advancePlan(req.user, id(req), action, req.body || {})));
export const postReturn = wrap(async (req, res) => res.json(await svc.returnPlan(req.user, id(req), req.body || {})));
export const getAwaitingPcmed = wrap(async (req, res) => res.json({ data: await svc.awaitingPcmed(req.user) }));
export const postDecision = wrap(async (req, res) => res.json(await svc.decideRecord(req.user, id(req), req.body || {})));
export const postRestore = wrap(async (req, res) => res.json(await svc.restoreRecord(req.user, id(req), req.body || {})));
export const getCompare = wrap(async (req, res) => res.json(await svc.compareVersions(req.user, id(req), req.query)));
export const postObservation = wrap(async (req, res) => res.json(await svc.addObservation(req.user, id(req), req.body || {})));
export const getVerified = wrap(async (req, res) => res.json(await svc.verifiedRecords(req.user, req.query)));
export const getHistory = wrap(async (req, res) => res.json(await svc.planHistory(req.user, id(req))));

// Central registers (System Management).
export const listRegister = (kind) => wrap(async (req, res) => res.json({ data: await svc.listRegister(kind) }));
export const createRegister = (kind) => wrap(async (req, res) => res.status(201).json(await svc.saveRegister(kind, req.user, null, req.body || {})));
export const updateRegister = (kind) => wrap(async (req, res) => res.json(await svc.saveRegister(kind, req.user, id(req), req.body || {})));
export const deleteRegister = (kind) =>
  wrap(async (req, res) => {
    await svc.deleteRegister(kind, id(req));
    res.status(204).end();
  });

/* ---------- reports ---------- */
import ExcelJS from "exceljs";
import { CEILING_KEYS, KEY_LABEL } from "../utils/ceilingKeys.js";

const MONEY = "#,##0.00";
const STATUS = { Draft: "Draft", PendingReview: "Pending Review", PendingApproval: "Pending Approval", SubmittedToPCMED: "Submitted to PCMED", UnderVerification: "Under Verification", Returned: "Returned for Revision", Verified: "Verified" };

function flat(outputs, accounts) {
  const rows = [];
  for (const o of outputs)
    for (const a of o.activities)
      for (const q of a.quarters) {
        if (!q.items.length) rows.push({ o, a, q, i: null });
        for (const i of q.items) rows.push({ o, a, q, i, acct: accounts.get(i.naturalAccountId) });
      }
  return rows;
}
function sheet(wb, name, title, head, rows, moneyCols = []) {
  const ws = wb.addWorksheet(name);
  ws.addRow([title]).font = { bold: true, size: 12 };
  ws.addRow([]);
  ws.addRow(head).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  ws.columns.forEach((c, i) => {
    c.width = moneyCols.includes(i) ? 16 : 28;
    if (moneyCols.includes(i)) c.numFmt = MONEY;
  });
  return ws;
}

/** Work Plan reports: plan, initial baseline, costing, ceiling reconciliation, revisions, quarters, history. */
export const exportPlan = wrap(async (req, res) => {
  const st = await svc.planForExport(req.user, id(req));
  const p = st.plan;
  const mark = p.status === "Verified" ? "VERIFIED" : "DRAFT / NOT VERIFIED";
  const head = `${p.organization} · FY ${p.year} · ${p.stage === "Revised" ? "Revised" : "Initial"} Work Plan (revision ${p.revision}) · ${STATUS[p.status]} · ${mark} · GH₵ exact`;
  const acc = st.accounts;
  const line = (r) => [r.o.output, r.a.description, r.q ? `Q${r.q.quarter}` : "", r.q?.description ?? "", r.i ? r.i.description : r.q?.noCost ? "No additional cost" : "Not costed", r.acct ? `${r.acct.code} ${r.acct.description}` : "", r.acct?.economic_classification ?? "", r.i?.fundingSource ?? "", r.i?.unitOfMeasure ?? "", r.i?.quantity ?? null, r.i?.unitCost ?? null, r.i?.frequency ?? null, r.i ? r.i.amountCents / 100 : null];
  const cols = ["Main Output", "Annual Activity", "Quarter", "Quarterly Activity", "Cost Item", "Natural Account", "Economic Classification", "Funding Source", "Unit", "Quantity", "Unit Cost", "Frequency", "Cost"];
  const wb = new ExcelJS.Workbook();
  sheet(wb, p.stage === "Revised" ? "Revised Work Plan" : "Work Plan", head, cols, flat(st.outputs, acc).map(line), [10, 12]);
  if (st.revision) {
    sheet(wb, "Initial Work Plan", `${p.organization} · FY ${p.year} · Initial Work Plan (baseline)`, cols, flat(st.revision.baseline, acc).map(line), [10, 12]);
    const costRows = [];
    const walk = (n, ctx) => {
      if (n.level === "item") {
        const r = n.target ?? n.base;
        const a = acc.get(r.naturalAccountId);
        costRows.push([ctx.activity, ctx.output, `Q${ctx.quarter}`, r.description, a ? `${a.code} ${a.description}` : "", r.fundingSource, r.unitOfMeasure, n.target?.quantity ?? null, n.target?.unitCost ?? null, n.target?.frequency ?? null, n.baseCents / 100, n.targetCents / 100, (n.baseCents - n.targetCents) / 100, n.type]);
      }
      n.children.forEach((c) => walk(c, { ...ctx, ...(n.level === "output" ? { output: n.targetLabel ?? n.baseLabel } : n.level === "activity" ? { activity: n.targetLabel ?? n.baseLabel } : n.level === "quarter" ? { quarter: n.quarter } : {}) }));
    };
    st.revision.compare.tree.forEach((n) => walk(n, {}));
    sheet(wb, "Consolidated Costing", head, ["Annual Activity", "Main Output", "Quarter", "Cost Item", "Natural Account", "Funding Source", "Unit", "Quantity", "Unit Cost", "Frequency", "Initial Cost", "Revised Cost", "Reduction", "Revision"], costRows, [7, 8, 9, 10, 11, 12]);
    const revRows = [];
    const walk2 = (n, path) => {
      const name = n.targetLabel ?? n.baseLabel;
      const where = [...path, name].join(" › ");
      if (n.type !== "Retained") {
        if (!n.changes.length) revRows.push([n.level, where, n.type, n.attrs.join(", "), "", "", "", n.baseCents / 100, n.targetCents / 100, n.diffCents / 100, n.reason ?? "", n.updatedBy ?? "", n.updatedAt ? new Date(n.updatedAt).toLocaleString("en-GB") : ""]);
        for (const c of n.changes) revRows.push([n.level, where, n.type, n.attrs.join(", "), c.name, c.from, c.to, n.baseCents / 100, n.targetCents / 100, n.diffCents / 100, n.reason ?? "", n.updatedBy ?? "", n.updatedAt ? new Date(n.updatedAt).toLocaleString("en-GB") : ""]);
      }
      n.children.forEach((c) => walk2(c, [...path, name]));
    };
    st.revision.compare.tree.forEach((n) => walk2(n, []));
    sheet(wb, "Schedule of Revisions", head, ["Level", "Record", "Revision", "Attributes", "Field", "Original", "Revised", "Initial Cost", "Revised Cost", "Difference", "Justification", "Officer", "Date"], revRows, [7, 8, 9]);
  }
  if (st.ceiling)
    sheet(
      wb,
      "Ceiling Reconciliation",
      head,
      ["Classification", "Initial Requirement", "Approved Ceiling", "Revised Requirement", "Available Balance"],
      CEILING_KEYS.map((k) => [KEY_LABEL[k], (st.ceiling.initial?.[k] ?? 0) / 100, st.ceiling.limit[k] / 100, st.ceiling.used[k] / 100, (st.ceiling.limit[k] - st.ceiling.used[k]) / 100]),
      [1, 2, 3, 4],
    );
  const quarter = (outputs) => [1, 2, 3, 4].map((n) => outputs.reduce((s, o) => s + o.activities.reduce((s2, a) => s2 + a.quarters.filter((q) => q.quarter === n).reduce((s3, q) => s3 + q.items.reduce((s4, i) => s4 + i.amountCents, 0), 0), 0), 0));
  const cur = quarter(st.outputs);
  const init = st.revision ? quarter(st.revision.baseline) : null;
  sheet(wb, "Quarterly Requirements", `${head} · activity costing by quarter (not a cash requirement)`, ["Quarter", "Initial Requirement", "Revised Requirement", "Difference"], cur.map((c, i) => [`Q${i + 1}`, init ? init[i] / 100 : null, c / 100, init ? (c - init[i]) / 100 : null]), [1, 2, 3]);
  sheet(wb, "Review History", head, ["Date", "Action", "From", "To", "Officer", "Role", "Remarks"], st.history.map((e) => [new Date(e.at).toLocaleString("en-GB"), e.action, e.from, e.to, e.actor, e.actorRole, e.comment]));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename=work_plan_${p.year}_${p.stage.toLowerCase()}_${p.organization.replace(/[^\w-]+/g, "_")}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});
