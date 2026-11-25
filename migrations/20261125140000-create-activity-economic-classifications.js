"use strict";

// Activities and economic classifications are many-to-many: one activity (per
// organisation) can be used under several classifications, and each classification
// has many activities. The expenditure form offers an activity under every
// classification linked to it. Activities with no links are treated as unclassified
// and offered under every classification until an administrator links them.

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("activity_economic_classifications", {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      activity_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "activities", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      // Compensation of Employees, Goods and Services or Capital Expenditure.
      economic_classification: { type: Sequelize.STRING(50), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("activity_economic_classifications", ["activity_id", "economic_classification"], {
      unique: true,
      name: "activity_economic_classifications_unique",
    });
    await queryInterface.addIndex("activity_economic_classifications", ["economic_classification"], {
      name: "activity_economic_classifications_class",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("activity_economic_classifications");
  },
};
