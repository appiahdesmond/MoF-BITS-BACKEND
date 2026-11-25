import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";
import User from "./users.js";

const Activity = sequelize.define(
  "Activity",
  {
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    organization: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "activities",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["name", "organization"],
      },
    ],
  },
);

/**
 * Link between an activity and an economic classification (many-to-many): an
 * activity can be used under several classifications.
 */
export const ActivityClassification = sequelize.define(
  "ActivityClassification",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    activity_id: { type: DataTypes.INTEGER, allowNull: false },
    economic_classification: { type: DataTypes.STRING(50), allowNull: false },
  },
  { tableName: "activity_economic_classifications", timestamps: true, underscored: true },
);

Activity.belongsTo(User, { foreignKey: "userId" });
User.hasMany(Activity, { foreignKey: "userId" });

Activity.hasMany(ActivityClassification, {
  foreignKey: "activity_id",
  as: "classifications",
  onDelete: "CASCADE",
});
ActivityClassification.belongsTo(Activity, { foreignKey: "activity_id" });

export default Activity;
