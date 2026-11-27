"use strict";

// Per-role settings managed under Roles & Permissions. For now: the page a role opens
// on after signing in. Roles without a row use their default landing page.

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("role_settings", {
      role: { type: Sequelize.STRING(20), primaryKey: true, allowNull: false },
      landing_page: { type: Sequelize.STRING(40), allowNull: true },
      updated_by: { type: Sequelize.STRING, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("role_settings");
  },
};
