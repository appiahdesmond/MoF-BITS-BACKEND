"use strict";

// Adds the "Returned" workflow step: a reviewer or approver can send a record back to
// the data entry officer for correction. The officer edits it and it returns to Pending.

const TABLES = ["revenues", "cash", "expenditures", "reallocation"];

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    for (const table of TABLES) {
      await queryInterface.sequelize.query(
        `ALTER TABLE \`${table}\` MODIFY status ENUM('Pending','Reviewed','Approved','Returned') NOT NULL DEFAULT 'Pending'`,
      );
      await queryInterface.addColumn(table, "returnReason", { type: Sequelize.TEXT, allowNull: true });
      await queryInterface.addColumn(table, "returnedBy", { type: Sequelize.STRING, allowNull: true });
      await queryInterface.addColumn(table, "returnedAt", { type: Sequelize.DATE, allowNull: true });
    }
    await queryInterface.sequelize.query(`
      ALTER TABLE Notifications
      MODIFY event ENUM('created', 'reviewed', 'approved', 'viewed', 'returned', 'resubmitted') NOT NULL
    `);
  },

  async down(queryInterface) {
    for (const table of TABLES) {
      // Returned records go back to Pending before the value is removed from the ENUM.
      await queryInterface.sequelize.query(
        `UPDATE \`${table}\` SET status = 'Pending' WHERE status = 'Returned'`,
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE \`${table}\` MODIFY status ENUM('Pending','Reviewed','Approved') NOT NULL DEFAULT 'Pending'`,
      );
      await queryInterface.removeColumn(table, "returnReason");
      await queryInterface.removeColumn(table, "returnedBy");
      await queryInterface.removeColumn(table, "returnedAt");
    }
    await queryInterface.sequelize.query(
      "DELETE FROM Notifications WHERE event IN ('returned', 'resubmitted')",
    );
    await queryInterface.sequelize.query(`
      ALTER TABLE Notifications
      MODIFY event ENUM('created', 'reviewed', 'approved', 'viewed') NOT NULL
    `);
  },
};
