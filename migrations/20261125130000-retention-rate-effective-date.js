"use strict";

// Retention rate changes now carry the date they take effect from and the approval
// that authorised them. Revenue uses the rate in force on its collection date.
// Existing changes are treated as effective from the day they were made.

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("retention_rate_changes", "effective_date", {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
    await queryInterface.sequelize.query(
      "UPDATE retention_rate_changes SET effective_date = DATE(created_at) WHERE effective_date IS NULL",
    );
    await queryInterface.changeColumn("retention_rate_changes", "effective_date", {
      type: Sequelize.DATEONLY,
      allowNull: false,
    });
    await queryInterface.addColumn("retention_rate_changes", "approval_reference", {
      type: Sequelize.STRING(100),
      allowNull: true,
    });
    await queryInterface.addIndex("retention_rate_changes", ["organization_id", "effective_date"], {
      name: "retention_rate_changes_org_effective",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("retention_rate_changes", "retention_rate_changes_org_effective");
    await queryInterface.removeColumn("retention_rate_changes", "approval_reference");
    await queryInterface.removeColumn("retention_rate_changes", "effective_date");
  },
};
