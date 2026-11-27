import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";
import User from "./users.js";

/** One step in a record's approval workflow (audit trail). */
export const WorkflowEvent = sequelize.define(
  "WorkflowEvent",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    entity_type: { type: DataTypes.STRING(20), allowNull: false },
    entity_id: { type: DataTypes.INTEGER, allowNull: false },
    organization: { type: DataTypes.STRING, allowNull: true },
    action: { type: DataTypes.STRING(30), allowNull: false },
    from_status: { type: DataTypes.STRING(30), allowNull: true },
    to_status: { type: DataTypes.STRING(30), allowNull: true },
    comment: { type: DataTypes.TEXT, allowNull: true },
    actor_id: { type: DataTypes.INTEGER, allowNull: true },
    actor_name: { type: DataTypes.STRING, allowNull: true },
    actor_role: { type: DataTypes.STRING(20), allowNull: true },
  },
  { tableName: "workflow_events", timestamps: true, underscored: true },
);

/** DADs a user is assigned to (data scope "assigned"). */
export const UserDadAssignment = sequelize.define(
  "UserDadAssignment",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    organization: { type: DataTypes.STRING, allowNull: false },
  },
  { tableName: "user_dad_assignments", timestamps: true, underscored: true },
);

User.hasMany(UserDadAssignment, { foreignKey: "user_id", as: "dadAssignments", onDelete: "CASCADE" });
UserDadAssignment.belongsTo(User, { foreignKey: "user_id" });
