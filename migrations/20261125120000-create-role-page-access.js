"use strict";

// Console › Roles & Permissions › Page Access: which pages each role may open.
//   role_page_access     – one row per role + page that differs from the default
//                          (every page allowed). Administrators are never limited.
//   role_access_changes  – log of every change, shown under Audit History.

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("role_page_access", {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      role: { type: Sequelize.STRING(20), allowNull: false },
      page: { type: Sequelize.STRING(40), allowNull: false },
      allowed: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      updated_by: { type: Sequelize.STRING, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("role_page_access", ["role", "page"], {
      unique: true,
      name: "role_page_access_role_page",
    });

    await queryInterface.createTable("role_access_changes", {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      role: { type: Sequelize.STRING(20), allowNull: false },
      page: { type: Sequelize.STRING(40), allowNull: false },
      allowed: { type: Sequelize.BOOLEAN, allowNull: false },
      changed_by_id: { type: Sequelize.INTEGER, allowNull: true },
      changed_by: { type: Sequelize.STRING, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("role_access_changes", ["role", "created_at"], {
      name: "role_access_changes_role_created",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("role_access_changes");
    await queryInterface.dropTable("role_page_access");
  },
};
