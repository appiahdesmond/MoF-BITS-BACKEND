import ExcelJS from "exceljs";
import * as svc from "../services/budgetCeiling.service.js";
import { CEILING_KEYS, FUNDS, KEY_LABEL } from "../utils/ceilingKeys.js";

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.statusCode && error.statusCode < 500)
      return res.status(error.statusCode).json({ message: error.message, code: error.code, revision: error.revision, validation: error.validation });
    next(error);
  }
};
const id = (req, k = "id") => Number(req.params[k]);

export const getWorkspace = wrap(async (req, res) => res.json(await svc.getWorkspace(req.user, req.query)));
export const getDistribution = wrap(async (req, res) => res.json(await svc.getDistribution(req.user, id(req))));
export const postMinistryCeiling = wrap(async (req, res) => res.json(await svc.saveMinistryCeiling(req.user, req.body || {}, req.file)));
export const getMinistryCeilings = wrap(async (req, res) => res.json({ data: await svc.ministryCeilingVersions(req.user, req.query.year) }));
export const putAllocations = wrap(async (req, res) => res.json(await svc.saveAllocations(req.user, id(req), req.body || {})));
export const postStep = (action) => wrap(async (req, res) => res.json(await svc.advance(req.user, id(req), action, req.body || {})));
export const postReturn = wrap(async (req, res) => res.json(await svc.returnDistribution(req.user, id(req), req.body || {})));
export const postRetry = wrap(async (req, res) => res.json(await svc.retryCommunication(req.user, id(req))));
export const getHistory = wrap(async (req, res) => res.json(await svc.history(req.user, id(req))));
export const getMonitoring = wrap(async (req, res) => res.json(await svc.monitoring(req.user, req.query)));
export const getAwaiting = wrap(async (req, res) => res.json({ data: await svc.awaitingMe(req.user) }));
export const getMine = wrap(async (req, res) => res.json(await svc.myCeiling(req.user, req.query)));
export const postAcknowledge = wrap(async (req, res) => res.json(await svc.acknowledge(req.user, id(req))));
export const getDocument = wrap(async (req, res) => {
  const doc = await svc.getDocument(id(req, "docId"));
  res.setHeader("Content-Type", doc.mime_type);
  res.setHeader("Content-Disposition", `inline; filename="${doc.file_name.replace(/"/g, "")}"`);
  res.end(doc.data);
});

const money = "#,##0.00";
const amt = (c) => (c === null || c === undefined ? null : c / 100);

function matrixSheet(wb, name, title, rows, extraRows = []) {
  const ws = wb.addWorksheet(name);
  ws.addRow([title]).font = { bold: true, size: 13 };
  ws.addRow(["Amounts in GH₵ (exact)"]);
  ws.addRow([]);
  const g = ws.addRow(["DADs", "GoG", "", "", "", "IGF", "", "", "", "FLG", "", "", "Grand Total"]);
  ws.mergeCells(g.number, 2, g.number, 5);
  ws.mergeCells(g.number, 6, g.number, 9);
  ws.mergeCells(g.number, 10, g.number, 12);
  g.font = { bold: true };
  ws.addRow(["", "COE", "G&S", "CAPEX", "Sub-total", "COE", "G&S", "CAPEX", "Sub-total", "G&S", "CAPEX", "Sub-total", ""]).font = { bold: true };
  const line = (label, a, bold) => {
    const v = (k) => (a?.[k] === null || a?.[k] === undefined ? null : a[k]);
    const sub = (f) => f.keys.reduce((s, k) => s + (v(k) ?? 0), 0);
    const r = ws.addRow([
      label,
      ...FUNDS.flatMap((f) => [...f.keys.map((k) => amt(v(k))), amt(sub(f))]),
      amt(FUNDS.reduce((s, f) => s + sub(f), 0)),
    ]);
    if (bold) r.font = { bold: true };
  };
  rows.forEach(([label, a]) => line(label, a));
  extraRows.forEach(([label, a]) => line(label, a, true));
  ws.columns.forEach((c, i) => {
    c.width = i === 0 ? 42 : 16;
    if (i > 0) c.numFmt = money;
  });
  return ws;
}

/** Workbook of the year's schedules: requirements, Ministry ceiling, distribution, reconciliation, monitoring, history. */
export const exportSchedules = wrap(async (req, res) => {
  const st = await svc.getDistribution(req.user, id(req));
  const d = st.distribution;
  const label = d.status === "Approved" ? "APPROVED" : ["Draft", "Returned"].includes(d.status) ? "DRAFT" : "PROPOSED";
  const total = (key) => st.allocations.reduce((s, a) => s + (a.amounts[key] ?? 0), 0);
  const distributed = Object.fromEntries(CEILING_KEYS.map((k) => [k, total(k)]));
  const ceiling = st.ceiling?.amounts ?? {};
  const unallocated = Object.fromEntries(CEILING_KEYS.map((k) => [k, (ceiling[k] ?? 0) - distributed[k]]));
  const wb = new ExcelJS.Workbook();
  const head = `FY ${d.year} · distribution version ${d.version} · ${svc.STATUS_LABEL[d.status]}`;
  matrixSheet(wb, "Initial Requirements", `Consolidated Initial Resource Requirements — ${head}${st.requirementsFrozen ? " (as submitted)" : ""}`, st.organizations.map((o) => [`${o.name}${st.requirements[o.name]?.status === "submitted" ? "" : " (not submitted)"}`, st.requirements[o.name]?.status === "submitted" ? st.requirements[o.name].amounts : null]));
  matrixSheet(wb, "Ministry Ceiling", `Ministry Budget Ceiling — FY ${d.year} · version ${st.ceiling?.version ?? "—"} · ref. ${st.ceiling?.reference || "—"} · communicated ${st.ceiling?.communicatedOn ?? "—"}`, [["Ministry Ceiling", ceiling]]);
  matrixSheet(wb, `${label === "APPROVED" ? "Approved" : "Proposed"} Distribution`, `${label} Institutional Ceiling Distribution — ${head}`, st.organizations.map((o) => [o.name, st.allocations.find((a) => a.organization === o.name)?.amounts ?? null]), [
    ["Total Distributed", distributed],
    ["Ministry Ceiling", ceiling],
    ["Unallocated Balance", unallocated],
  ]);
  const rec = wb.addWorksheet("Reconciliation");
  rec.addRow([`Financial Reconciliation — ${head}`]).font = { bold: true, size: 13 };
  rec.addRow(["Classification", "Ministry Ceiling", "Distributed Ceiling", "Unallocated Balance"]).font = { bold: true };
  CEILING_KEYS.forEach((k) => rec.addRow([KEY_LABEL[k], amt(ceiling[k] ?? 0), amt(distributed[k]), amt(unallocated[k])]));
  rec.columns.forEach((c, i) => {
    c.width = i === 0 ? 40 : 20;
    if (i) c.numFmt = money;
  });
  const mon = await svc.monitoring(req.user, { year: d.year });
  if (mon.approved) {
    const ws = wb.addWorksheet("Revision Monitoring");
    ws.addRow([`Revision Monitoring — FY ${d.year}`]).font = { bold: true, size: 13 };
    ws.addRow(["DAD", "Approved Ceiling", "Revised Requirement", "Available Balance", "Ceiling Receipt", "Revision Status", "Compliance"]).font = { bold: true };
    mon.rows.forEach((r) =>
      ws.addRow([r.organization, amt(r.approvedCents), amt(r.requirementCents), r.requirementCents === null ? null : amt(r.approvedCents - r.requirementCents), r.ceiling.acknowledgedAt ? "Acknowledged" : r.ceiling.notifiedAt ? "Notified" : "Published", r.status, r.compliance.state]),
    );
    ws.columns.forEach((c, i) => {
      c.width = i === 0 ? 40 : 18;
      if (i >= 1 && i <= 3) c.numFmt = money;
    });
  }
  const h = await svc.history(req.user, d.id);
  const hs = wb.addWorksheet("Approval History");
  hs.addRow(["Date", "Action", "From", "To", "Officer", "Role", "Remarks"]).font = { bold: true };
  h.events.forEach((e) => hs.addRow([new Date(e.at).toLocaleString("en-GB"), e.action, e.from, e.to, e.actor, e.actorRole, e.comment]));
  hs.columns.forEach((c, i) => (c.width = i === 6 ? 80 : 20));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename=budget_ceilings_${d.year}_v${d.version}_${label.toLowerCase()}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

/** A DAD's own approved ceiling schedule. */
export const exportMine = wrap(async (req, res) => {
  const { ceiling, organization } = await svc.myCeiling(req.user, req.query);
  if (!ceiling) return res.status(404).json({ message: "No approved ceiling yet" });
  const wb = new ExcelJS.Workbook();
  matrixSheet(wb, "Approved Ceiling", `Approved Budget Ceiling — ${organization} · FY ${ceiling.year} · ref. ${ceiling.reference} · approved ${new Date(ceiling.approvedAt).toLocaleString("en-GB")} by ${ceiling.approvedBy}`, [[organization, ceiling.amounts]]);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename=budget_ceiling_${ceiling.year}_${organization.replace(/[^\w-]+/g, "_")}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});
