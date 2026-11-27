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

/** A role's permission, where it differs from the role's default. */
export const RolePermission = sequelize.define(
  "RolePermission",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    role: { type: DataTypes.STRING(20), allowNull: false },
    permission: { type: DataTypes.STRING(40), allowNull: false },
    allowed: { type: DataTypes.BOOLEAN, allowNull: false },
    updated_by: { type: DataTypes.STRING, allowNull: true },
  },
  { tableName: "role_permissions", timestamps: true, underscored: true },
);

/** One change to a role's page access or permissions (Audit History). */
export const RoleAccessChange = sequelize.define(
  "RoleAccessChange",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    role: { type: DataTypes.STRING(20), allowNull: false },
    page: { type: DataTypes.STRING(40), allowNull: false }, // page or permission key
    kind: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "page" }, // page | permission
    allowed: { type: DataTypes.BOOLEAN, allowNull: false },
    changed_by_id: { type: DataTypes.INTEGER, allowNull: true },
    changed_by: { type: DataTypes.STRING, allowNull: true },
  },
  { tableName: "role_access_changes", timestamps: true, underscored: true },
);

/** Per-role settings (default landing page). */
export const RoleSetting = sequelize.define(
  "RoleSetting",
  {
    role: { type: DataTypes.STRING(20), primaryKey: true },
    landing_page: { type: DataTypes.STRING(40), allowNull: true },
    updated_by: { type: DataTypes.STRING, allowNull: true },
  },
  { tableName: "role_settings", timestamps: true, underscored: true },
);
