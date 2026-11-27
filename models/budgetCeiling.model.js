// Budget Ceilings (see migrations/20261128130000-budget-ceilings.js).
import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";
import { CEILING_KEYS } from "../utils/ceilingKeys.js";

const stamps = { timestamps: true, underscored: true, createdAt: "created_at", updatedAt: "updated_at" };
const who = { created_by: DataTypes.STRING, created_by_id: DataTypes.INTEGER, updated_by: DataTypes.STRING, updated_by_id: DataTypes.INTEGER };
const amounts = (nullable) => Object.fromEntries(CEILING_KEYS.map((k) => [k, { type: DataTypes.DECIMAL(15, 2), allowNull: nullable, ...(nullable ? {} : { defaultValue: 0 }) }]));
const step = (p) => ({ [`${p}_by`]: DataTypes.STRING, [`${p}_by_id`]: DataTypes.INTEGER, [`${p}_at`]: DataTypes.DATE, [`${p}_comment`]: DataTypes.TEXT });
export const DISTRIBUTION_STATUSES = ["Draft", "PendingRecommendation", "PendingEndorsement", "PendingApproval", "Returned", "Approved"];

export const CeilingDocument = sequelize.define(
  "CeilingDocument",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    file_name: { type: DataTypes.STRING(255), allowNull: false },
    mime_type: { type: DataTypes.STRING(120), allowNull: false },
    size: { type: DataTypes.INTEGER, allowNull: false },
    data: { type: DataTypes.BLOB("long"), allowNull: false },
    created_by: DataTypes.STRING,
    created_by_id: DataTypes.INTEGER,
  },
  { tableName: "ceiling_documents", ...stamps },
);

export const MinistryCeiling = sequelize.define(
  "MinistryCeiling",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    year: { type: DataTypes.INTEGER, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    reference: DataTypes.STRING(120),
    communicated_on: DataTypes.DATEONLY,
    remarks: DataTypes.TEXT,
    document_id: DataTypes.INTEGER,
    amendment_reason: DataTypes.TEXT,
    ...amounts(false),
    ...who,
  },
  { tableName: "ministry_ceilings", ...stamps },
);

export const CeilingDistribution = sequelize.define(
  "CeilingDistribution",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    year: { type: DataTypes.INTEGER, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    ministry_ceiling_id: DataTypes.INTEGER,
    status: { type: DataTypes.ENUM(...DISTRIBUTION_STATUSES), allowNull: false, defaultValue: "Draft" },
    revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    requirements_snapshot: DataTypes.JSON,
    ...step("submitted"),
    ...step("recommended"),
    ...step("endorsed"),
    ...step("approved"),
    returned_by: DataTypes.STRING,
    returned_by_id: DataTypes.INTEGER,
    returned_at: DataTypes.DATE,
    return_reason: DataTypes.TEXT,
    returned_stage: DataTypes.STRING(30),
    ...who,
  },
  { tableName: "ceiling_distributions", ...stamps },
);

export const CeilingAllocation = sequelize.define(
  "CeilingAllocation",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    distribution_id: { type: DataTypes.INTEGER, allowNull: false },
    organization: { type: DataTypes.STRING, allowNull: false },
    ...amounts(true),
    updated_by: DataTypes.STRING,
  },
  { tableName: "ceiling_allocations", ...stamps },
);

export const CeilingDistributionVersion = sequelize.define(
  "CeilingDistributionVersion",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    distribution_id: { type: DataTypes.INTEGER, allowNull: false },
    revision: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.STRING(30), allowNull: false },
    snapshot: { type: DataTypes.JSON, allowNull: false },
    created_by: DataTypes.STRING,
    created_by_id: DataTypes.INTEGER,
  },
  { tableName: "ceiling_distribution_versions", ...stamps },
);

export const DadCeiling = sequelize.define(
  "DadCeiling",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    distribution_id: { type: DataTypes.INTEGER, allowNull: false },
    year: { type: DataTypes.INTEGER, allowNull: false },
    organization: { type: DataTypes.STRING, allowNull: false },
    ...amounts(false),
    approved_by: { type: DataTypes.STRING, allowNull: false },
    approved_at: { type: DataTypes.DATE, allowNull: false },
    communication_reference: { type: DataTypes.STRING(160), allowNull: false },
    published_at: DataTypes.DATE,
    notified_at: DataTypes.DATE,
    acknowledged_at: DataTypes.DATE,
    acknowledged_by: DataTypes.STRING,
    work_plan_id: DataTypes.INTEGER,
    activation_status: { type: DataTypes.ENUM("pending", "activated", "failed"), allowNull: false, defaultValue: "pending" },
    activation_error: DataTypes.TEXT,
  },
  { tableName: "dad_ceilings", ...stamps },
);

CeilingDistribution.hasMany(CeilingAllocation, { foreignKey: "distribution_id", as: "allocations", onDelete: "CASCADE" });
CeilingDistribution.belongsTo(MinistryCeiling, { foreignKey: "ministry_ceiling_id", as: "ministryCeiling" });
MinistryCeiling.belongsTo(CeilingDocument, { foreignKey: "document_id", as: "document" });
CeilingDistribution.hasMany(DadCeiling, { foreignKey: "distribution_id", as: "dadCeilings" });
