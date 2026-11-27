"use strict";

// Work Plan module and the two central registers it reads from.
//
//   natural_accounts       Chart of Accounts: natural accounts (System Management). Seeded from
//                          the natural accounts already on loaded budget lines ("2111101 Established Post").
//   strategic_objectives   Strategic framework: adopted objectives (System Management).
//   work_plans             One plan per DAD, year and stage (Initial; Revised after ceilings).
//   work_plan_outputs → work_plan_activities → work_plan_quarter_activities → work_plan_cost_items
//   work_plan_versions     The plan as submitted, for audit and comparison.
// Child rows cascade with their parent, so no costing record can be orphaned. Amounts are
// DECIMAL(15,2) and always recalculated on the server from the cost drivers.

const STATUSES = ["Draft", "PendingReview", "PendingApproval", "SubmittedToPCMED", "UnderVerification", "Returned", "Verified"];
const NOTIFY_BEFORE = ["revenue", "cash", "expenditure", "reallocation", "cashPlan"];
const NOTIFY_AFTER = [...NOTIFY_BEFORE, "workPlan"];

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    const S = Sequelize;
    const stamps = { created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false } };
    const who = { created_by: { type: S.STRING, allowNull: true }, updated_by: { type: S.STRING, allowNull: true } };
    try {
      await queryInterface.createTable(
        "natural_accounts",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          code: { type: S.STRING(20), allowNull: false, unique: true }, // text: keeps leading zeros
          description: { type: S.STRING(255), allowNull: false },
          economic_classification: { type: S.STRING(60), allowNull: false },
          is_posting: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
          valid_from_year: { type: S.INTEGER, allowNull: true },
          valid_to_year: { type: S.INTEGER, allowNull: true },
          status: { type: S.ENUM("active", "inactive"), allowNull: false, defaultValue: "active" },
          ...who,
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.createTable(
        "strategic_objectives",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          code: { type: S.STRING(30), allowNull: false, unique: true },
          objective: { type: S.STRING(500), allowNull: false },
          valid_from_year: { type: S.INTEGER, allowNull: true },
          valid_to_year: { type: S.INTEGER, allowNull: true },
          status: { type: S.ENUM("active", "inactive"), allowNull: false, defaultValue: "active" },
          ...who,
          ...stamps,
        },
        { transaction: t },
      );

      const step = (p) => ({ [`${p}_by`]: { type: S.STRING, allowNull: true }, [`${p}_by_id`]: { type: S.INTEGER, allowNull: true }, [`${p}_at`]: { type: S.DATE, allowNull: true } });
      await queryInterface.createTable(
        "work_plans",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          organization: { type: S.STRING, allowNull: false },
          year: { type: S.INTEGER, allowNull: false },
          stage: { type: S.ENUM("Initial", "Revised"), allowNull: false, defaultValue: "Initial" },
          parent_plan_id: { type: S.INTEGER, allowNull: true, references: { model: "work_plans", key: "id" }, onDelete: "SET NULL" },
          status: { type: S.ENUM(...STATUSES), allowNull: false, defaultValue: "Draft" },
          revision: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
          ...step("submitted"),
          submission_remarks: { type: S.TEXT, allowNull: true },
          ...step("recommended"),
          recommendation_comment: { type: S.TEXT, allowNull: true },
          ...step("dad_approved"),
          reviewed_by: { type: S.STRING, allowNull: true },
          reviewed_by_id: { type: S.INTEGER, allowNull: true },
          review_started_at: { type: S.DATE, allowNull: true },
          ...step("approved"),
          approval_comment: { type: S.TEXT, allowNull: true },
          returned_by: { type: S.STRING, allowNull: true },
          returned_at: { type: S.DATE, allowNull: true },
          return_reason: { type: S.TEXT, allowNull: true },
          returned_stage: { type: S.STRING(30), allowNull: true },
          created_by_id: { type: S.INTEGER, allowNull: true },
          updated_by_id: { type: S.INTEGER, allowNull: true },
          ...who,
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.addIndex("work_plans", ["organization", "year", "stage"], { unique: true, name: "work_plans_org_year_stage", transaction: t });

      await queryInterface.createTable(
        "work_plan_outputs",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          work_plan_id: { type: S.INTEGER, allowNull: false, references: { model: "work_plans", key: "id" }, onDelete: "CASCADE" },
          objective_id: { type: S.INTEGER, allowNull: true, references: { model: "strategic_objectives", key: "id" }, onDelete: "RESTRICT" },
          output: { type: S.TEXT, allowNull: false },
          means_of_verification: { type: S.TEXT, allowNull: true },
          sort: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
          ...who,
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.createTable(
        "work_plan_activities",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          output_id: { type: S.INTEGER, allowNull: false, references: { model: "work_plan_outputs", key: "id" }, onDelete: "CASCADE" },
          description: { type: S.TEXT, allowNull: false },
          sort: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
          ...who,
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.createTable(
        "work_plan_quarter_activities",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          activity_id: { type: S.INTEGER, allowNull: false, references: { model: "work_plan_activities", key: "id" }, onDelete: "CASCADE" },
          quarter: { type: S.TINYINT, allowNull: false },
          description: { type: S.TEXT, allowNull: true },
          no_cost: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
          sort: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
          ...who,
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.createTable(
        "work_plan_cost_items",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          quarter_activity_id: { type: S.INTEGER, allowNull: false, references: { model: "work_plan_quarter_activities", key: "id" }, onDelete: "CASCADE" },
          natural_account_id: { type: S.INTEGER, allowNull: true, references: { model: "natural_accounts", key: "id" }, onDelete: "RESTRICT" },
          description: { type: S.STRING(500), allowNull: true },
          funding_source: { type: S.STRING(20), allowNull: true },
          unit_of_measure: { type: S.STRING(60), allowNull: true },
          costing_method: { type: S.STRING(20), allowNull: false, defaultValue: "quantity" },
          quantity: { type: S.DECIMAL(18, 4), allowNull: true },
          unit_cost: { type: S.DECIMAL(15, 2), allowNull: true },
          frequency: { type: S.DECIMAL(18, 4), allowNull: true },
          amount: { type: S.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
          copied_from_id: { type: S.INTEGER, allowNull: true },
          sort: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
          ...who,
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.createTable(
        "work_plan_versions",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          work_plan_id: { type: S.INTEGER, allowNull: false, references: { model: "work_plans", key: "id" }, onDelete: "CASCADE" },
          revision: { type: S.INTEGER, allowNull: false },
          status: { type: S.STRING(30), allowNull: false },
          total: { type: S.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
          snapshot: { type: S.JSON, allowNull: false },
          created_by_id: { type: S.INTEGER, allowNull: true },
          created_by: { type: S.STRING, allowNull: true },
          ...stamps,
        },
        { transaction: t },
      );

      await queryInterface.changeColumn("Notifications", "entityType", { type: S.ENUM(...NOTIFY_AFTER), allowNull: false }, { transaction: t });

      // Seed the Chart of Accounts from the natural accounts already on loaded budget lines.
      const [rows] = await queryInterface.sequelize.query("SELECT DISTINCT naturalAccount AS na, economicClassification AS ec FROM loadeddata", { transaction: t });
      const seen = new Map();
      for (const r of rows) {
        const m = String(r.na ?? "").trim().match(/^(\d+)\s*[-–]?\s*(.*)$/);
        if (!m || seen.has(m[1])) continue;
        seen.set(m[1], { code: m[1], description: m[2] || m[1], economic_classification: r.ec || "Goods and Services" });
      }
      const now = new Date();
      if (seen.size)
        await queryInterface.bulkInsert(
          "natural_accounts",
          [...seen.values()].map((a) => ({ ...a, is_posting: true, status: "active", created_by: "Seeded from loaded budget lines", created_at: now, updated_at: now })),
          { transaction: t },
        );
      await t.commit();
    } catch (error) {
      await t.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    for (const table of ["work_plan_versions", "work_plan_cost_items", "work_plan_quarter_activities", "work_plan_activities", "work_plan_outputs", "work_plans", "strategic_objectives", "natural_accounts"])
      await queryInterface.dropTable(table);
    await queryInterface.sequelize.query("DELETE FROM Notifications WHERE entityType = 'workPlan'");
    await queryInterface.changeColumn("Notifications", "entityType", { type: Sequelize.ENUM(...NOTIFY_BEFORE), allowNull: false });
  },
};
