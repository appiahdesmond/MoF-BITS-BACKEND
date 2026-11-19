"use strict";

// Moves organisations and their IGF retention rates out of hard-coded lists
// (data/organizationRetentionRate.js and the frontend option lists) into the database.

const SEED = [
  ["Finance Headquarters", 25],
  ["Controller and Acct. Generals Dept", 61],
  ["Statistical Service", 58],
  ["Public Procurement Authority", 47],
  ["Institute of Accountancy Training", 39],
  ["Securities and Exchange Commission", 33],
  ["Ghana Revenue Authority", 72],
  ["Independent Tax Appeals Board (ITAB)", 28],
  ["Financial Intelligence Centre", 44],
  ["State Interest and Governance Authority", 36],
  ["Internal Audit Agency", 52],
  ["National Pensions and Regulatory Authority", 41],
];

// Rates that existed in the old backend table without a matching organisation option.
const EXTRA_RATES = { MOF: 25 };

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("organizations", {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      name: { type: Sequelize.STRING, allowNull: false, unique: true },
      code: { type: Sequelize.STRING(20), allowNull: true },
      status: {
        type: Sequelize.ENUM("active", "inactive"),
        allowNull: false,
        defaultValue: "active",
      },
      retention_rate: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable("retention_rate_changes", {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      organization_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "organizations", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      old_rate: { type: Sequelize.INTEGER, allowNull: true },
      new_rate: { type: Sequelize.INTEGER, allowNull: false },
      note: { type: Sequelize.STRING, allowNull: true },
      changed_by: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    // Seed: the known list, plus any organisation already used by an existing user.
    const [userOrgs] = await queryInterface.sequelize.query(
      "SELECT DISTINCT organization FROM users WHERE organization IS NOT NULL AND organization <> ''",
    );
    const rows = new Map(SEED.map(([name, rate]) => [name, rate]));
    for (const { organization } of userOrgs) {
      if (!rows.has(organization)) {
        rows.set(organization, EXTRA_RATES[organization] ?? null);
      }
    }

    const now = new Date();
    await queryInterface.bulkInsert(
      "organizations",
      [...rows].map(([name, rate]) => ({
        name,
        code: null,
        status: "active",
        retention_rate: rate,
        created_at: now,
        updated_at: now,
      })),
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable("retention_rate_changes");
    await queryInterface.dropTable("organizations");
  },
};
