"use strict";

// Cash plan workflow with the DAD's internal review (BITS Design System, Phase 7):
//   Draft → Pending Review (DAD Reviewer) → Pending Approval (DAD Approver)
//   → Submitted to PCMED → Under Verification (PCMED) → Verified
// Any step may return the plan for correction ("Returned"); a returned plan goes through
// the internal review again. Existing rows are mapped to the new statuses (no data is
// removed): Submitted → SubmittedToPCMED, UnderReview → UnderVerification, Approved → Verified.
// Each submission is preserved in cash_plan_versions.

const OLD = ["Draft", "Submitted", "UnderReview", "Returned", "Approved"];
const NEW = ["Draft", "PendingReview", "PendingApproval", "SubmittedToPCMED", "UnderVerification", "Returned", "Verified"];

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    try {
      const both = [...new Set([...OLD, ...NEW])];
      await queryInterface.changeColumn("cash_plans", "status", { type: Sequelize.ENUM(...both), allowNull: false, defaultValue: "Draft" }, { transaction: t });
      await queryInterface.sequelize.query(
        `UPDATE cash_plans SET status = CASE status
           WHEN 'Submitted' THEN 'SubmittedToPCMED'
           WHEN 'UnderReview' THEN 'UnderVerification'
           WHEN 'Approved' THEN 'Verified'
           ELSE status END`,
        { transaction: t },
      );
      await queryInterface.changeColumn("cash_plans", "status", { type: Sequelize.ENUM(...NEW), allowNull: false, defaultValue: "Draft" }, { transaction: t });

      const cols = {
        submitted_by_id: { type: Sequelize.INTEGER, allowNull: true },
        recommended_by: { type: Sequelize.STRING, allowNull: true },
        recommended_by_id: { type: Sequelize.INTEGER, allowNull: true },
        recommended_at: { type: Sequelize.DATE, allowNull: true },
        recommendation_comment: { type: Sequelize.TEXT, allowNull: true },
        dad_approved_by: { type: Sequelize.STRING, allowNull: true },
        dad_approved_by_id: { type: Sequelize.INTEGER, allowNull: true },
        dad_approved_at: { type: Sequelize.DATE, allowNull: true },
        reviewed_by_id: { type: Sequelize.INTEGER, allowNull: true }, // PCMED officer who started verification
        approved_by_id: { type: Sequelize.INTEGER, allowNull: true }, // PCMED officer who verified
        returned_stage: { type: Sequelize.STRING(30), allowNull: true },
      };
      for (const [name, def] of Object.entries(cols)) await queryInterface.addColumn("cash_plans", name, def, { transaction: t });

      await queryInterface.createTable(
        "cash_plan_versions",
        {
          id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
          cash_plan_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "cash_plans", key: "id" }, onDelete: "CASCADE" },
          revision: { type: Sequelize.INTEGER, allowNull: false },
          status: { type: Sequelize.STRING(30), allowNull: false },
          // Every line's budget and monthly amounts (pesewas) at the moment of submission.
          snapshot: { type: Sequelize.JSON, allowNull: false },
          created_by_id: { type: Sequelize.INTEGER, allowNull: true },
          created_by: { type: Sequelize.STRING, allowNull: true },
          created_at: { type: Sequelize.DATE, allowNull: false },
          updated_at: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction: t },
      );
      await t.commit();
    } catch (error) {
      await t.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("cash_plan_versions");
    for (const name of ["submitted_by_id", "recommended_by", "recommended_by_id", "recommended_at", "recommendation_comment", "dad_approved_by", "dad_approved_by_id", "dad_approved_at", "reviewed_by_id", "approved_by_id", "returned_stage"])
      await queryInterface.removeColumn("cash_plans", name);
    const both = [...new Set([...OLD, ...NEW])];
    await queryInterface.changeColumn("cash_plans", "status", { type: Sequelize.ENUM(...both), allowNull: false, defaultValue: "Draft" });
    await queryInterface.sequelize.query(
      `UPDATE cash_plans SET status = CASE status
         WHEN 'SubmittedToPCMED' THEN 'Submitted' WHEN 'PendingReview' THEN 'Submitted' WHEN 'PendingApproval' THEN 'Submitted'
         WHEN 'UnderVerification' THEN 'UnderReview' WHEN 'Verified' THEN 'Approved' ELSE status END`,
    );
    await queryInterface.changeColumn("cash_plans", "status", { type: Sequelize.ENUM(...OLD), allowNull: false, defaultValue: "Draft" });
  },
};
