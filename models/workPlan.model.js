// Work Plan and the central registers it reads (see migrations/20261128120000-work-plan.js).
import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";

const stamps = { timestamps: true, underscored: true, createdAt: "created_at", updatedAt: "updated_at" };
const who = { created_by: DataTypes.STRING, updated_by: DataTypes.STRING };
export const WORK_PLAN_STATUSES = ["Draft", "PendingReview", "PendingApproval", "SubmittedToPCMED", "UnderVerification", "Returned", "Verified"];

/** Chart of Accounts: natural accounts (System Management › Financial Configuration). */
export const NaturalAccount = sequelize.define(
  "NaturalAccount",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    code: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    description: { type: DataTypes.STRING(255), allowNull: false },
    economic_classification: { type: DataTypes.STRING(60), allowNull: false },
    is_posting: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    valid_from_year: DataTypes.INTEGER,
    valid_to_year: DataTypes.INTEGER,
    status: { type: DataTypes.ENUM("active", "inactive"), allowNull: false, defaultValue: "active" },
    ...who,
  },
  { tableName: "natural_accounts", ...stamps },
);

/** Strategic framework: adopted objectives (System Management › Institutional Configuration). */
export const StrategicObjective = sequelize.define(
  "StrategicObjective",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    code: { type: DataTypes.STRING(30), allowNull: false, unique: true },
    objective: { type: DataTypes.STRING(500), allowNull: false },
    valid_from_year: DataTypes.INTEGER,
    valid_to_year: DataTypes.INTEGER,
    status: { type: DataTypes.ENUM("active", "inactive"), allowNull: false, defaultValue: "active" },
    ...who,
  },
  { tableName: "strategic_objectives", ...stamps },
);

const step = (p) => ({ [`${p}_by`]: DataTypes.STRING, [`${p}_by_id`]: DataTypes.INTEGER, [`${p}_at`]: DataTypes.DATE });

export const WorkPlan = sequelize.define(
  "WorkPlan",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    organization: { type: DataTypes.STRING, allowNull: false },
    year: { type: DataTypes.INTEGER, allowNull: false },
    stage: { type: DataTypes.ENUM("Initial", "Revised"), allowNull: false, defaultValue: "Initial" },
    parent_plan_id: DataTypes.INTEGER,
    status: { type: DataTypes.ENUM(...WORK_PLAN_STATUSES), allowNull: false, defaultValue: "Draft" },
    revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...step("submitted"),
    submission_remarks: DataTypes.TEXT,
    ...step("recommended"),
    recommendation_comment: DataTypes.TEXT,
    ...step("dad_approved"),
    reviewed_by: DataTypes.STRING,
    reviewed_by_id: DataTypes.INTEGER,
    review_started_at: DataTypes.DATE,
    ...step("approved"),
    approval_comment: DataTypes.TEXT,
    returned_by: DataTypes.STRING,
    returned_at: DataTypes.DATE,
    return_reason: DataTypes.TEXT,
    returned_stage: DataTypes.STRING(30),
    created_by_id: DataTypes.INTEGER,
    updated_by_id: DataTypes.INTEGER,
    ceiling_id: DataTypes.INTEGER, // Revised Work Plan: the DAD's approved ceiling (dad_ceilings)
    activated_revision: DataTypes.INTEGER,
    ...who,
  },
  { tableName: "work_plans", ...stamps },
);

export const WorkPlanOutput = sequelize.define(
  "WorkPlanOutput",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    work_plan_id: { type: DataTypes.INTEGER, allowNull: false },
    objective_id: DataTypes.INTEGER,
    output: { type: DataTypes.TEXT, allowNull: false },
    means_of_verification: DataTypes.TEXT,
    origin_id: DataTypes.INTEGER, // Revised Work Plan: the Initial Work Plan record it came from
    sort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...who,
  },
  { tableName: "work_plan_outputs", ...stamps },
);

export const WorkPlanActivity = sequelize.define(
  "WorkPlanActivity",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    output_id: { type: DataTypes.INTEGER, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false },
    origin_id: DataTypes.INTEGER,
    revision_reason: DataTypes.TEXT,
    reason_basis_cents: DataTypes.BIGINT,
    sort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...who,
  },
  { tableName: "work_plan_activities", ...stamps },
);

export const WorkPlanQuarterActivity = sequelize.define(
  "WorkPlanQuarterActivity",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    activity_id: { type: DataTypes.INTEGER, allowNull: false },
    quarter: { type: DataTypes.TINYINT, allowNull: false },
    description: DataTypes.TEXT,
    no_cost: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    origin_id: DataTypes.INTEGER,
    sort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...who,
  },
  { tableName: "work_plan_quarter_activities", ...stamps },
);

export const WorkPlanCostItem = sequelize.define(
  "WorkPlanCostItem",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    quarter_activity_id: { type: DataTypes.INTEGER, allowNull: false },
    natural_account_id: DataTypes.INTEGER,
    description: DataTypes.STRING(500),
    funding_source: DataTypes.STRING(20),
    unit_of_measure: DataTypes.STRING(60),
    costing_method: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "quantity" },
    quantity: DataTypes.DECIMAL(18, 4),
    unit_cost: DataTypes.DECIMAL(15, 2),
    frequency: DataTypes.DECIMAL(18, 4),
    amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
    copied_from_id: DataTypes.INTEGER,
    origin_id: DataTypes.INTEGER,
    revision_reason: DataTypes.TEXT,
    sort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...who,
  },
  { tableName: "work_plan_cost_items", ...stamps },
);

export const WorkPlanVersion = sequelize.define(
  "WorkPlanVersion",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    work_plan_id: { type: DataTypes.INTEGER, allowNull: false },
    revision: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.STRING(30), allowNull: false },
    total: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
    snapshot: { type: DataTypes.JSON, allowNull: false },
    created_by_id: DataTypes.INTEGER,
    created_by: DataTypes.STRING,
  },
  { tableName: "work_plan_versions", ...stamps },
);

WorkPlan.hasMany(WorkPlanOutput, { foreignKey: "work_plan_id", as: "outputs", onDelete: "CASCADE" });
WorkPlanOutput.belongsTo(WorkPlan, { foreignKey: "work_plan_id" });
WorkPlanOutput.belongsTo(StrategicObjective, { foreignKey: "objective_id", as: "objective" });
WorkPlanOutput.hasMany(WorkPlanActivity, { foreignKey: "output_id", as: "activities", onDelete: "CASCADE" });
WorkPlanActivity.belongsTo(WorkPlanOutput, { foreignKey: "output_id", as: "outputRecord" });
WorkPlanActivity.hasMany(WorkPlanQuarterActivity, { foreignKey: "activity_id", as: "quarters", onDelete: "CASCADE" });
WorkPlanQuarterActivity.belongsTo(WorkPlanActivity, { foreignKey: "activity_id", as: "activityRecord" });
WorkPlanQuarterActivity.hasMany(WorkPlanCostItem, { foreignKey: "quarter_activity_id", as: "items", onDelete: "CASCADE" });
WorkPlanCostItem.belongsTo(WorkPlanQuarterActivity, { foreignKey: "quarter_activity_id", as: "quarterActivity" });
WorkPlanCostItem.belongsTo(NaturalAccount, { foreignKey: "natural_account_id", as: "naturalAccount" });
WorkPlan.hasMany(WorkPlanVersion, { foreignKey: "work_plan_id", as: "versions", onDelete: "CASCADE" });

/** Baseline records removed or deferred in a Revised Work Plan (with the reason). */
export const WorkPlanDecision = sequelize.define(
  "WorkPlanDecision",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    work_plan_id: { type: DataTypes.INTEGER, allowNull: false },
    record_type: { type: DataTypes.ENUM("output", "activity", "quarter", "item"), allowNull: false },
    origin_id: { type: DataTypes.INTEGER, allowNull: false },
    decision: { type: DataTypes.ENUM("removed", "deferred"), allowNull: false },
    reason: DataTypes.TEXT,
    created_by: DataTypes.STRING,
    created_by_id: DataTypes.INTEGER,
  },
  { tableName: "work_plan_revision_decisions", ...stamps },
);

/** Review observations on a Work Plan or one of its records. */
export const WorkPlanObservation = sequelize.define(
  "WorkPlanObservation",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    work_plan_id: { type: DataTypes.INTEGER, allowNull: false },
    record_type: { type: DataTypes.ENUM("plan", "output", "activity", "quarter", "item"), allowNull: false, defaultValue: "plan" },
    record_id: DataTypes.INTEGER,
    record_label: DataTypes.STRING(300),
    stage: { type: DataTypes.STRING(30), allowNull: false },
    text: { type: DataTypes.TEXT, allowNull: false },
    created_by: DataTypes.STRING,
    created_by_id: DataTypes.INTEGER,
    created_by_role: DataTypes.STRING(40),
    resolved_at: DataTypes.DATE,
  },
  { tableName: "work_plan_observations", ...stamps },
);
