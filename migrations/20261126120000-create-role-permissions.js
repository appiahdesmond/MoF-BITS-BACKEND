"use strict";

// Roles & Permissions › Permissions: what each role may do with records (create,
// edit, review, approve, return, export). Rows are stored only where a role differs
// from its default. role_access_changes now logs both page access and permission
// changes; `kind` says which.

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("role_permissions", {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      role: { type: Sequelize.STRING(20), allowNull: false },
      permission: { type: Sequelize.STRING(40), allowNull: false },
      allowed: { type: Sequelize.BOOLEAN, allowNull: false },
      updated_by: { type: Sequelize.STRING, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("role_permissions", ["role", "permission"], {
      unique: true,
      name: "role_permissions_role_permission",
    });
    await queryInterface.addColumn("role_access_changes", "kind", {
      type: Sequelize.STRING(12),
      allowNull: false,
      defaultValue: "page",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("role_access_changes", "kind");
    await queryInterface.dropTable("role_permissions");
  },
};
