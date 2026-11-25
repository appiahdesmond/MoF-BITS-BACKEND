import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";

/** A role's access to one page, where it differs from the default (allowed). */
export const RolePageAccess = sequelize.define(
  "RolePageAccess",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    role: { type: DataTypes.STRING(20), allowNull: false },
    page: { type: DataTypes.STRING(40), allowNull: false },
    allowed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    updated_by: { type: DataTypes.STRING, allowNull: true },
  },
  { tableName: "role_page_access", timestamps: true, underscored: true },
);

/** One change to a role's page access (Audit History). */
export const RoleAccessChange = sequelize.define(
  "RoleAccessChange",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    role: { type: DataTypes.STRING(20), allowNull: false },
    page: { type: DataTypes.STRING(40), allowNull: false },
    allowed: { type: DataTypes.BOOLEAN, allowNull: false },
    changed_by_id: { type: DataTypes.INTEGER, allowNull: true },
    changed_by: { type: DataTypes.STRING, allowNull: true },
  },
  { tableName: "role_access_changes", timestamps: true, underscored: true },
);
