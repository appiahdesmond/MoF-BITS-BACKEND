"use strict";

// Executive roles: Minister, Deputy Minister and Chief Director. Ministry-wide,
// read-only oversight; what they see is set by page access, permissions and data scope.

const BASE = "'admin','data_entry','approver','reviewer','pcmed_reviewer','pcmed_approver'";

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE users MODIFY role ENUM(${BASE},'minister','deputy_minister','chief_director') DEFAULT 'data_entry'`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "UPDATE users SET role = 'reviewer', status = 'inactive' WHERE role IN ('minister','deputy_minister','chief_director')",
    );
    await queryInterface.sequelize.query(`ALTER TABLE users MODIFY role ENUM(${BASE}) DEFAULT 'data_entry'`);
  },
};
