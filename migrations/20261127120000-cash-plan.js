"use strict";

// Annual Cash Plan.
//
// 1. Budget lines (loadeddata) gain the Activity/Operation they belong to and a
//    policy classification, so a cash plan can be prepared per activity. Existing
//    lines keep NULL activity until they are reloaded with one.
// 2. Cash plan tables: one header per DAD, year and version; one line per
//    activity × economic classification × funding source; the budget lines each
//    plan line adds up; and one row per line and month with the planned amount.
//    Annual and quarterly totals are always calculated from the monthly rows.

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn("loadeddata", "activityCode", { type: Sequelize.STRING(50), allowNull: true }, { transaction: t });
      await queryInterface.addColumn("loadeddata", "activity", { type: Sequelize.STRING(255), allowNull: true }, { transaction: t });
      await queryInterface.addColumn(
        "loadeddata",
        "policyClassification",
        { type: Sequelize.ENUM("Normal", "KPI"), allowNull: false, defaultValue: "Normal" },
        { transaction: t },
      );

      const stamps = {
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      };

      await queryInterface.createTable(
        "cash_plans",
        {
          id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
          year: { type: Sequelize.INTEGER, allowNull: false },
          organization: { type: Sequelize.STRING, allowNull: false },
          version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
          budget_version: { type: Sequelize.STRING(50), allowNull: true },
          status: {
            type: Sequelize.ENUM("Draft", "Submitted", "UnderReview", "Returned", "Approved"),
            allowNull: false,
            defaultValue: "Draft",
          },
          // Incremented on every saved change; a save that names an older revision is refused.
          revision: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          created_by_id: { type: Sequelize.INTEGER, allowNull: true },
          created_by: { type: Sequelize.STRING, allowNull: true },
          updated_by_id: { type: Sequelize.INTEGER, allowNull: true },
          updated_by: { type: Sequelize.STRING, allowNull: true },
          submission_remarks: { type: Sequelize.TEXT, allowNull: true },
          submitted_by: { type: Sequelize.STRING, allowNull: true },
          submitted_at: { type: Sequelize.DATE, allowNull: true },
          reviewed_by: { type: Sequelize.STRING, allowNull: true },
          review_started_at: { type: Sequelize.DATE, allowNull: true },
          returned_by: { type: Sequelize.STRING, allowNull: true },
          returned_at: { type: Sequelize.DATE, allowNull: true },
          return_reason: { type: Sequelize.TEXT, allowNull: true },
          approved_by: { type: Sequelize.STRING, allowNull: true },
          approved_at: { type: Sequelize.DATE, allowNull: true },
          approval_comment: { type: Sequelize.TEXT, allowNull: true },
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.addIndex("cash_plans", ["year", "organization", "version"], {
        unique: true,
        name: "cash_plans_year_org_version",
        transaction: t,
      });

      await queryInterface.createTable(
        "cash_plan_lines",
        {
          id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
          cash_plan_id: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: { model: "cash_plans", key: "id" },
            onDelete: "CASCADE",
          },
          // sha1 of activity code (or name) | economic classification | funding source.
          line_key: { type: Sequelize.STRING(40), allowNull: false },
          activity_code: { type: Sequelize.STRING(50), allowNull: true },
          activity: { type: Sequelize.STRING(255), allowNull: true },
          economic_classification: { type: Sequelize.STRING, allowNull: false },
          source_of_funding: { type: Sequelize.STRING, allowNull: false },
          policy_classification: { type: Sequelize.ENUM("Normal", "KPI"), allowNull: false, defaultValue: "Normal" },
          justification: { type: Sequelize.TEXT, allowNull: true },
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.addIndex("cash_plan_lines", ["cash_plan_id", "line_key"], {
        unique: true,
        name: "cash_plan_lines_plan_key",
        transaction: t,
      });

      await queryInterface.createTable(
        "cash_plan_line_budget_lines",
        {
          id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
          cash_plan_line_id: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: { model: "cash_plan_lines", key: "id" },
            onDelete: "CASCADE",
          },
          loaded_data_id: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: { model: "loadeddata", key: "id" },
            onDelete: "CASCADE",
          },
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.addIndex("cash_plan_line_budget_lines", ["cash_plan_line_id", "loaded_data_id"], {
        unique: true,
        name: "cash_plan_line_budget_unique",
        transaction: t,
      });

      await queryInterface.createTable(
        "cash_plan_allocations",
        {
          id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
          cash_plan_line_id: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: { model: "cash_plan_lines", key: "id" },
            onDelete: "CASCADE",
          },
          month: { type: Sequelize.TINYINT, allowNull: false },
          amount: { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.addIndex("cash_plan_allocations", ["cash_plan_line_id", "month"], {
        unique: true,
        name: "cash_plan_allocations_line_month",
        transaction: t,
      });

      await t.commit();
    } catch (error) {
      await t.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable("cash_plan_allocations");
    await queryInterface.dropTable("cash_plan_line_budget_lines");
    await queryInterface.dropTable("cash_plan_lines");
    await queryInterface.dropTable("cash_plans");
    await queryInterface.removeColumn("loadeddata", "policyClassification");
    await queryInterface.removeColumn("loadeddata", "activity");
    await queryInterface.removeColumn("loadeddata", "activityCode");
  },
};
