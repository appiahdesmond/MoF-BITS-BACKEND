import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";
import User from "./users.js";

const Cash = sequelize.define(
  "Cash",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },

    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    organization: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    as_at_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },

    account_name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    currency: {
      type: DataTypes.ENUM("GHS", "USD", "GBP", "EUR"),
      allowNull: false,
    },

    balance: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
    },

    // PCMED review and final approval (after the DAD approves).
    pcmedReviewedBy: { type: DataTypes.STRING, allowNull: true },
    pcmedReviewedById: { type: DataTypes.INTEGER, allowNull: true },
    pcmedReviewedAt: { type: DataTypes.DATE, allowNull: true },
    pcmedReviewComment: { type: DataTypes.TEXT, allowNull: true },
    pcmedApprovedBy: { type: DataTypes.STRING, allowNull: true },
    pcmedApprovedById: { type: DataTypes.INTEGER, allowNull: true },
    pcmedApprovedAt: { type: DataTypes.DATE, allowNull: true },
    pcmedApprovalComment: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.ENUM(
        "Pending",
        "Reviewed",
        "Approved",
        "Returned",
        "PendingPCMEDReview",
        "PendingPCMEDApproval",
        "ReturnedByPCMED",
      ),
      defaultValue: "Pending",
      allowNull: false,
    },

    // Reviewer details
    reviewedBy: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    reviewedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    reviewComment: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    // Approver details
    approvedBy: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    returnReason: { type: DataTypes.TEXT, allowNull: true },
    returnedBy: { type: DataTypes.STRING, allowNull: true },
    returnedAt: { type: DataTypes.DATE, allowNull: true },
    approvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "cash",
    freezeTableName: true,
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["organization", "as_at_date", "account_name", "currency"],
      },
    ],
  },
);

User.hasMany(Cash, { foreignKey: "user_id" });
Cash.belongsTo(User, { foreignKey: "user_id" });

export default Cash;
