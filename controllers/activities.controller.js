// Activities per organisation, each linked to one or more economic classifications
// (many-to-many through activity_economic_classifications).
import ExcelJS from "exceljs";
import sequelize from "../config/database.js";
import Activity, { ActivityClassification } from "../models/activity.model.js";

export const ECONOMIC_CLASSIFICATIONS = [
  "Compensation of Employees",
  "Goods and Services",
  "Capital Expenditure",
];

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

/**
 * Classifications from a request value: an array, or text separated by commas,
 * semicolons or new lines. Matching is case-insensitive. Returns { list, invalid }.
 */
function parseClassifications(value) {
  const raw = (Array.isArray(value) ? value : String(value ?? "").split(/[,;\n]+/))
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);
  const list = [];
  const invalid = [];
  raw.forEach((v) => {
    const match = ECONOMIC_CLASSIFICATIONS.find((c) => c.toLowerCase() === v.toLowerCase());
    if (!match) invalid.push(v);
    else if (!list.includes(match)) list.push(match);
  });
  return { list, invalid };
}

const classificationError = (invalid) =>
  `Economic classification${invalid.length ? ` "${invalid.join('", "')}" is not valid.` : " is required."} Use ${ECONOMIC_CLASSIFICATIONS.join(", ")}.`;

/** Activity as returned to the app: { id, name, organization, economic_classifications }. */
const present = (activity) => {
  const plain = activity.toJSON();
  const classes = (plain.classifications || []).map((c) => c.economic_classification);
  delete plain.classifications;
  return {
    ...plain,
    economic_classifications: ECONOMIC_CLASSIFICATIONS.filter((c) => classes.includes(c)),
  };
};

const withClassifications = {
  model: ActivityClassification,
  as: "classifications",
  attributes: ["economic_classification"],
};

/**
 * Create the activity if needed and link it to every classification given (links
 * that already exist are kept). Returns the number of new links.
 */
async function upsertActivity({ name, organization, classifications, userId }, transaction) {
  const [activity] = await Activity.findOrCreate({
    where: { name, organization },
    defaults: { name, organization, userId },
    transaction,
  });
  let added = 0;
  for (const economic_classification of classifications) {
    const [, created] = await ActivityClassification.findOrCreate({
      where: { activity_id: activity.id, economic_classification },
      transaction,
    });
    if (created) added += 1;
  }
  return added;
}

// POST /api/activity  { organization, name, economicClassifications }
// `name` may hold several activities separated by commas or new lines; each is
// linked to every classification given.
export const createActivities = async (req, res, next) => {
  try {
    const { organization, name } = req.body;
    if (!organization || !name) {
      return res.status(400).json({ message: "Organization and activity name are required" });
    }
    const { list, invalid } = parseClassifications(
      req.body.economicClassifications ?? req.body.economicClassification,
    );
    if (!list.length || invalid.length) return next(fail(400, classificationError(invalid)));

    const names = [
      ...new Set(
        String(name)
          .split(/[\n,]+/)
          .map((a) => a.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    await sequelize.transaction(async (transaction) => {
      for (const activityName of names) {
        await upsertActivity(
          { name: activityName, organization, classifications: list, userId: req.user.id },
          transaction,
        );
      }
    });

    res.status(201).json({ message: "Activity(ies) saved successfully", activities: names.length });
  } catch (error) {
    next(error);
  }
};

// POST /api/activity/bulk-upload  (.xlsx: organization | name | economic_classifications)
// A row may list several classifications separated by commas or semicolons, and the
// same activity may appear on several rows; all its classifications are linked.
export const bulkUploadActivities = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: "Excel file is required" });
    if (!req.user) return res.status(401).json({ message: "Unauthorized user." });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) return res.status(400).json({ message: "Invalid Excel file" });

    const merged = new Map(); // organization|name -> Set of classifications
    const invalidRows = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const organization = row.getCell(1).value;
      const activity = row.getCell(2).value;
      if (!organization || !activity) return;
      const { list, invalid } = parseClassifications(row.getCell(3).text);
      if (!list.length || invalid.length) {
        invalidRows.push(rowNumber);
        return;
      }
      const key = `${String(organization).trim()}|${String(activity).trim().toLowerCase()}`;
      const set = merged.get(key) ?? new Set();
      list.forEach((c) => set.add(c));
      merged.set(key, set);
    });

    if (invalidRows.length) {
      return res.status(400).json({
        message: `Row${invalidRows.length === 1 ? "" : "s"} ${invalidRows.slice(0, 10).join(", ")}${
          invalidRows.length > 10 ? "…" : ""
        }: economic_classifications must list one or more of ${ECONOMIC_CLASSIFICATIONS.join(", ")}`,
      });
    }
    if (!merged.size) return res.status(400).json({ message: "Excel file contains no valid data" });

    let links = 0;
    await sequelize.transaction(async (transaction) => {
      for (const [key, classes] of merged) {
        const [organization, name] = key.split("|");
        links += await upsertActivity(
          { name, organization, classifications: [...classes], userId: req.user.id },
          transaction,
        );
      }
    });

    res.status(201).json({ message: "Bulk upload successful", inserted: merged.size, links });
  } catch (error) {
    next(error);
  }
};

// GET /api/activity/template
export const downloadActivityTemplate = async (req, res, next) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Activity Template");

    sheet.columns = [
      { header: "organization", key: "organization", width: 35 },
      { header: "name", key: "name", width: 40 },
      { header: "economic_classifications", key: "economic_classifications", width: 55 },
    ];

    // Sample rows: one or more classifications per activity, separated by commas.
    sheet.addRow({
      organization: "Finance Headquarters",
      name: "Audit",
      economic_classifications: "Goods and Services, Capital Expenditure",
    });
    sheet.addRow({
      organization: "Finance Headquarters",
      name: "Payroll",
      economic_classifications: "Compensation of Employees",
    });
    sheet.addRow({
      organization: "Statistical Service",
      name: "Census",
      economic_classifications: "Compensation of Employees, Goods and Services",
    });

    sheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "F4CAF50" } };
    });
    sheet.getCell("C1").note = `One or more of: ${ECONOMIC_CLASSIFICATIONS.join(", ")}. Separate several with commas.`;
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=activity_bulk_template.xlsx");
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

// GET /api/activity/my — the signed-in user's organisation's activities.
export const getMyActivities = async (req, res, next) => {
  try {
    const activities = await Activity.findAll({
      where: { organization: req.user.organization },
      attributes: ["id", "name"],
      include: [withClassifications],
      order: [["name", "ASC"]],
    });
    res.status(200).json(activities.map(present));
  } catch (error) {
    next(error);
  }
};

// GET /api/activity — all activities (administrators).
export const getAllActivities = async (req, res, next) => {
  try {
    const activities = await Activity.findAll({
      include: [withClassifications],
      order: [
        ["organization", "ASC"],
        ["name", "ASC"],
      ],
    });
    res.status(200).json(activities.map(present));
  } catch (error) {
    next(error);
  }
};

// DELETE /api/activity/:id — its classification links are removed with it.
export const deleteActivity = async (req, res, next) => {
  try {
    const activity = await Activity.findByPk(req.params.id);
    if (!activity) return res.status(404).json({ message: "Activity not found" });
    await activity.destroy();
    res.status(200).json({ message: "Activity deleted successfully" });
  } catch (error) {
    next(error);
  }
};

// PUT /api/activity/:id  { name, organization, economicClassifications? }
// When economicClassifications is given, it replaces the activity's links.
export const updateActivity = async (req, res, next) => {
  try {
    const { name, organization } = req.body;
    if (!name || !organization) {
      return res.status(400).json({ message: "Name and organization are required" });
    }
    const activity = await Activity.findByPk(req.params.id);
    if (!activity) return res.status(404).json({ message: "Activity not found" });

    let classes = null;
    if (req.body.economicClassifications !== undefined) {
      const { list, invalid } = parseClassifications(req.body.economicClassifications);
      if (!list.length || invalid.length) return next(fail(400, classificationError(invalid)));
      classes = list;
    }

    await sequelize.transaction(async (transaction) => {
      activity.name = name.trim().toLowerCase();
      activity.organization = organization.trim();
      await activity.save({ transaction }); // unique constraint protects duplicates
      if (classes) {
        await ActivityClassification.destroy({ where: { activity_id: activity.id }, transaction });
        await ActivityClassification.bulkCreate(
          classes.map((economic_classification) => ({ activity_id: activity.id, economic_classification })),
          { transaction },
        );
      }
    });

    const updated = await Activity.findByPk(activity.id, { include: [withClassifications] });
    res.status(200).json({ message: "Activity updated successfully", activity: present(updated) });
  } catch (error) {
    next(error);
  }
};
