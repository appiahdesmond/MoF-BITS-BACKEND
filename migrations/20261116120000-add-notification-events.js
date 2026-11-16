"use strict";

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE Notifications
      MODIFY event ENUM('created', 'reviewed', 'approved', 'viewed') NOT NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE Notifications
      MODIFY event ENUM('created', 'reviewed') NOT NULL
    `);
  },
};
