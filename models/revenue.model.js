import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";
import User from "./users.js";

const Revenue = sequelize.define(
  "Revenue",
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

    // Retention percentage from user's organization
    retention_rate: {
      type: DataTypes.INTEGER(2),
      allowNull: false,
    },

    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },

    revenue_category: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    // Actual collection entered by user
    actual_collection: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },

    budgetProjections: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },

    // Retention amount auto-calculated
    retention_amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },

    // Payment into consolidated fund auto-calculated
    payment_amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },

    remarks: {
      type: DataTypes.TEXT,
      allowNull: true,
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
    tableName: 'revenues',
    timestamps: true,
  }
);

User.hasMany(Revenue);
Revenue.belongsTo(User);

export default Revenue;
