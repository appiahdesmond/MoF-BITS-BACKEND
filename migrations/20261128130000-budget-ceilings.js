"use strict";

// Budget Ceilings (PCMED): the Ministry ceiling communicated by the Budget Office, its
// distribution across DADs, the approval chain, the published DAD ceilings and their link to
// each DAD's Revised Work Plan.
//
//   ceiling_documents            supporting documents (stored in the database for audit)
//   ministry_ceilings            each version of the Ministry ceiling (8 classifications)
//   ceiling_distributions        each version of the consolidated distribution + workflow
//   ceiling_allocations          one row per DAD per distribution (8 classifications; NULL = not entered)
//   ceiling_distribution_versions immutable copy at each submission
//   dad_ceilings                 published ceiling per DAD after final approval
// Also: work_plans.ceiling_id / activated_revision (Revised Work Plan), Work Plan funding
// source DPF becomes FLG (Foreign Loans and Grants), and the 'budgetCeiling' notification type.

const KEYS = ["gog_coe", "gog_gs", "gog_capex", "igf_coe", "igf_gs", "igf_capex", "flg_gs", "flg_capex"];
const DIST_STATUSES = ["Draft", "PendingRecommendation", "PendingEndorsement", "PendingApproval", "Returned", "Approved"];
const NOTIFY_BEFORE = ["revenue", "cash", "expenditure", "reallocation", "cashPlan", "workPlan"];
const NOTIFY_AFTER = [...NOTIFY_BEFORE, "budgetCeiling"];

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    const t = await queryInterface.sequelize.transaction();
    const stamps = { created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false } };
    const who = { created_by: { type: S.STRING, allowNull: true }, created_by_id: { type: S.INTEGER, allowNull: true }, updated_by: { type: S.STRING, allowNull: true }, updated_by_id: { type: S.INTEGER, allowNull: true } };
    const amounts = (nullable) => Object.fromEntries(KEYS.map((k) => [k, { type: S.DECIMAL(15, 2), allowNull: nullable, ...(nullable ? {} : { defaultValue: 0 }) }]));
    const step = (p) => ({ [`${p}_by`]: { type: S.STRING, allowNull: true }, [`${p}_by_id`]: { type: S.INTEGER, allowNull: true }, [`${p}_at`]: { type: S.DATE, allowNull: true }, [`${p}_comment`]: { type: S.TEXT, allowNull: true } });
    try {
      await queryInterface.createTable(
        "ceiling_documents",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          file_name: { type: S.STRING(255), allowNull: false },
          mime_type: { type: S.STRING(120), allowNull: false },
          size: { type: S.INTEGER, allowNull: false },
          data: { type: S.BLOB("long"), allowNull: false },
          created_by: { type: S.STRING, allowNull: true },
          created_by_id: { type: S.INTEGER, allowNull: true },
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.createTable(
        "ministry_ceilings",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          year: { type: S.INTEGER, allowNull: false },
          version: { type: S.INTEGER, allowNull: false },
          reference: { type: S.STRING(120), allowNull: true },
          communicated_on: { type: S.DATEONLY, allowNull: true },
          remarks: { type: S.TEXT, allowNull: true },
          document_id: { type: S.INTEGER, allowNull: true, references: { model: "ceiling_documents", key: "id" }, onDelete: "RESTRICT" },
          amendment_reason: { type: S.TEXT, allowNull: true },
          ...amounts(false),
          ...who,
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.addIndex("ministry_ceilings", ["year", "version"], { unique: true, name: "ministry_ceilings_year_version", transaction: t });

      await queryInterface.createTable(
        "ceiling_distributions",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          year: { type: S.INTEGER, allowNull: false },
          version: { type: S.INTEGER, allowNull: false },
          ministry_ceiling_id: { type: S.INTEGER, allowNull: true, references: { model: "ministry_ceilings", key: "id" }, onDelete: "RESTRICT" },
          status: { type: S.ENUM(...DIST_STATUSES), allowNull: false, defaultValue: "Draft" },
          revision: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
          // Initial resource requirements used for this distribution (frozen at submission).
          requirements_snapshot: { type: S.JSON, allowNull: true },
          ...step("submitted"),
          ...step("recommended"),
          ...step("endorsed"),
          ...step("approved"),
          returned_by: { type: S.STRING, allowNull: true },
          returned_by_id: { type: S.INTEGER, allowNull: true },
          returned_at: { type: S.DATE, allowNull: true },
          return_reason: { type: S.TEXT, allowNull: true },
          returned_stage: { type: S.STRING(30), allowNull: true },
          ...who,
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.addIndex("ceiling_distributions", ["year", "version"], { unique: true, name: "ceiling_distributions_year_version", transaction: t });

      await queryInterface.createTable(
        "ceiling_allocations",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          distribution_id: { type: S.INTEGER, allowNull: false, references: { model: "ceiling_distributions", key: "id" }, onDelete: "CASCADE" },
          organization: { type: S.STRING, allowNull: false },
          ...amounts(true),
          updated_by: { type: S.STRING, allowNull: true },
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.addIndex("ceiling_allocations", ["distribution_id", "organization"], { unique: true, name: "ceiling_allocations_dist_org", transaction: t });

      await queryInterface.createTable(
        "ceiling_distribution_versions",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          distribution_id: { type: S.INTEGER, allowNull: false, references: { model: "ceiling_distributions", key: "id" }, onDelete: "CASCADE" },
          revision: { type: S.INTEGER, allowNull: false },
          status: { type: S.STRING(30), allowNull: false },
          snapshot: { type: S.JSON, allowNull: false },
          created_by: { type: S.STRING, allowNull: true },
          created_by_id: { type: S.INTEGER, allowNull: true },
          ...stamps,
        },
        { transaction: t },
      );

      await queryInterface.createTable(
        "dad_ceilings",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          distribution_id: { type: S.INTEGER, allowNull: false, references: { model: "ceiling_distributions", key: "id" }, onDelete: "RESTRICT" },
          year: { type: S.INTEGER, allowNull: false },
          organization: { type: S.STRING, allowNull: false },
          ...amounts(false),
          approved_by: { type: S.STRING, allowNull: false },
          approved_at: { type: S.DATE, allowNull: false },
          communication_reference: { type: S.STRING(160), allowNull: false },
          published_at: { type: S.DATE, allowNull: true },
          notified_at: { type: S.DATE, allowNull: true },
          acknowledged_at: { type: S.DATE, allowNull: true },
          acknowledged_by: { type: S.STRING, allowNull: true },
          work_plan_id: { type: S.INTEGER, allowNull: true },
          activation_status: { type: S.ENUM("pending", "activated", "failed"), allowNull: false, defaultValue: "pending" },
          activation_error: { type: S.TEXT, allowNull: true },
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.addIndex("dad_ceilings", ["distribution_id", "organization"], { unique: true, name: "dad_ceilings_dist_org", transaction: t });

      await queryInterface.addColumn("work_plans", "ceiling_id", { type: S.INTEGER, allowNull: true, references: { model: "dad_ceilings", key: "id" }, onDelete: "RESTRICT" }, { transaction: t });
      await queryInterface.addColumn("work_plans", "activated_revision", { type: S.INTEGER, allowNull: true }, { transaction: t });
      // FLG (Foreign Loans and Grants) replaces DPF in the Work Plan (decision of 27 Nov 2026).
      await queryInterface.sequelize.query("UPDATE work_plan_cost_items SET funding_source = 'FLG' WHERE funding_source = 'DPF'", { transaction: t });
      await queryInterface.changeColumn("Notifications", "entityType", { type: S.ENUM(...NOTIFY_AFTER), allowNull: false }, { transaction: t });
      await t.commit();
    } catch (error) {
      await t.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn("work_plans", "activated_revision");
    await queryInterface.removeColumn("work_plans", "ceiling_id");
    for (const table of ["dad_ceilings", "ceiling_distribution_versions", "ceiling_allocations", "ceiling_distributions", "ministry_ceilings", "ceiling_documents"]) await queryInterface.dropTable(table);
    await queryInterface.sequelize.query("UPDATE work_plan_cost_items SET funding_source = 'DPF' WHERE funding_source = 'FLG'");
    await queryInterface.sequelize.query("DELETE FROM Notifications WHERE entityType = 'budgetCeiling'");
    await queryInterface.changeColumn("Notifications", "entityType", { type: Sequelize.ENUM(...NOTIFY_BEFORE), allowNull: false });
  },
};
