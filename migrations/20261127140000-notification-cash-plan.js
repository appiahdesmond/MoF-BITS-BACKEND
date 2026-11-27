"use strict";

// Notifications can refer to cash plans (workflow steps of the annual cash plan).
// Adds a value to the entity type list; no existing rows change.
const BEFORE = ["revenue", "cash", "expenditure", "reallocation"];
const AFTER = [...BEFORE, "cashPlan"];

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn("Notifications", "entityType", { type: Sequelize.ENUM(...AFTER), allowNull: false });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query("DELETE FROM Notifications WHERE entityType = 'cashPlan'");
    await queryInterface.changeColumn("Notifications", "entityType", { type: Sequelize.ENUM(...BEFORE), allowNull: false });
  },
};
