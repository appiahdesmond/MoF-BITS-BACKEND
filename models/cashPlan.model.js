// Annual Cash Plan (see migrations/20261127120000-cash-plan.js).
import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";
import LoadedData from "./loadedData.js";

const stamps = { timestamps: true, underscored: true, createdAt: "created_at", updatedAt: "updated_at" };

// Draft → PendingReview (DAD Reviewer) → PendingApproval (DAD Approver) → SubmittedToPCMED
// → UnderVerification (PCMED) → Verified; any step may return the plan ("Returned").
export const CASH_PLAN_STATUSES = ["Draft", "PendingReview", "PendingApproval", "SubmittedToPCMED", "UnderVerification", "Returned", "Verified"];

export const CashPlan = sequelize.define(
  "CashPlan",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    year: { type: DataTypes.INTEGER, allowNull: false },
    organization: { type: DataTypes.STRING, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    budget_version: { type: DataTypes.STRING(50), allowNull: true },
    status: { type: DataTypes.ENUM(...CASH_PLAN_STATUSES), allowNull: false, defaultValue: "Draft" },
    revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    created_by_id: DataTypes.INTEGER,
    created_by: DataTypes.STRING,
    updated_by_id: DataTypes.INTEGER,
    updated_by: DataTypes.STRING,
    submission_remarks: DataTypes.TEXT,
    submitted_by: DataTypes.STRING,
    submitted_at: DataTypes.DATE,
    reviewed_by: DataTypes.STRING,
    review_started_at: DataTypes.DATE,
    returned_by: DataTypes.STRING,
    returned_at: DataTypes.DATE,
    return_reason: DataTypes.TEXT,
    approved_by: DataTypes.STRING,
    approved_at: DataTypes.DATE,
    approval_comment: DataTypes.TEXT,
    submitted_by_id: DataTypes.INTEGER,
    recommended_by: DataTypes.STRING,
    recommended_by_id: DataTypes.INTEGER,
    recommended_at: DataTypes.DATE,
    recommendation_comment: DataTypes.TEXT,
    dad_approved_by: DataTypes.STRING,
    dad_approved_by_id: DataTypes.INTEGER,
    dad_approved_at: DataTypes.DATE,
    reviewed_by_id: DataTypes.INTEGER,
    approved_by_id: DataTypes.INTEGER,
    returned_stage: DataTypes.STRING(30),
  },
  { tableName: "cash_plans", ...stamps },
);

export const CashPlanLine = sequelize.define(
  "CashPlanLine",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    cash_plan_id: { type: DataTypes.INTEGER, allowNull: false },
    line_key: { type: DataTypes.STRING(40), allowNull: false },
    activity_code: DataTypes.STRING(50),
    activity: DataTypes.STRING(255),
    economic_classification: { type: DataTypes.STRING, allowNull: false },
    source_of_funding: { type: DataTypes.STRING, allowNull: false },
    policy_classification: { type: DataTypes.ENUM("Normal", "KPI"), allowNull: false, defaultValue: "Normal" },
    justification: DataTypes.TEXT,
  },
  { tableName: "cash_plan_lines", ...stamps },
);

export const CashPlanLineBudget = sequelize.define(
  "CashPlanLineBudget",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    cash_plan_line_id: { type: DataTypes.INTEGER, allowNull: false },
    loaded_data_id: { type: DataTypes.INTEGER, allowNull: false },
  },
  { tableName: "cash_plan_line_budget_lines", ...stamps },
);

export const CashPlanAllocation = sequelize.define(
  "CashPlanAllocation",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    cash_plan_line_id: { type: DataTypes.INTEGER, allowNull: false },
    month: { type: DataTypes.TINYINT, allowNull: false },
    amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  },
  { tableName: "cash_plan_allocations", ...stamps },
);

CashPlan.hasMany(CashPlanLine, { foreignKey: "cash_plan_id", as: "lines", onDelete: "CASCADE" });
CashPlanLine.belongsTo(CashPlan, { foreignKey: "cash_plan_id" });
CashPlanLine.hasMany(CashPlanAllocation, { foreignKey: "cash_plan_line_id", as: "allocations", onDelete: "CASCADE" });
CashPlanLine.hasMany(CashPlanLineBudget, { foreignKey: "cash_plan_line_id", as: "budgetLinks", onDelete: "CASCADE" });
CashPlanLineBudget.belongsTo(LoadedData, { foreignKey: "loaded_data_id" });

/** The plan as it stood at each submission (preserved for audit and comparison). */
export const CashPlanVersion = sequelize.define(
  "CashPlanVersion",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    cash_plan_id: { type: DataTypes.INTEGER, allowNull: false },
    revision: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.STRING(30), allowNull: false },
    snapshot: { type: DataTypes.JSON, allowNull: false },
    created_by_id: DataTypes.INTEGER,
    created_by: DataTypes.STRING,
  },
  { tableName: "cash_plan_versions", ...stamps },
);
CashPlan.hasMany(CashPlanVersion, { foreignKey: "cash_plan_id", as: "versions", onDelete: "CASCADE" });
