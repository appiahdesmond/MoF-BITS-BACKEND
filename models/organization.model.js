import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";
import User from "./users.js";

export const Organization = sequelize.define(
  "Organization",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: { notEmpty: { msg: "Organisation name is required" } },
    },
    code: { type: DataTypes.STRING(20), allowNull: true },
    status: {
      type: DataTypes.ENUM("active", "inactive"),
      allowNull: false,
      defaultValue: "active",
    },
    // Whole-number percentage of IGF collections the organisation retains.
    // Null means not configured: revenue can't be recorded until it is set.
    retention_rate: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: { min: 0, max: 100 },
    },
  },
  { tableName: "organizations", timestamps: true, underscored: true },
);

export const RetentionRateChange = sequelize.define(
  "RetentionRateChange",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    organization_id: { type: DataTypes.INTEGER, allowNull: false },
    old_rate: { type: DataTypes.INTEGER, allowNull: true },
    new_rate: { type: DataTypes.INTEGER, allowNull: false },
    note: { type: DataTypes.STRING, allowNull: true },
    changed_by: { type: DataTypes.INTEGER, allowNull: true },
  },
  { tableName: "retention_rate_changes", timestamps: true, underscored: true },
);

Organization.hasMany(RetentionRateChange, { foreignKey: "organization_id" });
RetentionRateChange.belongsTo(Organization, { foreignKey: "organization_id" });
RetentionRateChange.belongsTo(User, { foreignKey: "changed_by", as: "changedBy" });

export default Organization;
