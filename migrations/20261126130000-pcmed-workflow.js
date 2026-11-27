"use strict";

// PCMED review and final approval.
//
//   Pending (DAD review) → Reviewed (DAD approval) → PendingPCMEDReview
//     → PendingPCMEDApproval → Approved (verified, used by dashboards and reports)
//   Returned            – returned by the DAD reviewer or approver to data entry
//   ReturnedByPCMED     – returned by the PCMED reviewer to the originating DAD
//
// Adds the PCMED Reviewer and PCMED Approver roles, per-user data scope (all DADs or
// assigned DADs), PCMED decision fields on every record table, and workflow_events:
// a history of every step (who, role, when, from/to status, comment or reason).
// Records already Approved stay final.

const RECORD_TABLES = ["revenues", "cash", "expenditures", "reallocation"];
const STATUSES = "'Pending','Reviewed','Approved','Returned','PendingPCMEDReview','PendingPCMEDApproval','ReturnedByPCMED'";
const OLD_STATUSES = "'Pending','Reviewed','Approved','Returned'";

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    const q = queryInterface.sequelize;

    await q.query(
      "ALTER TABLE users MODIFY role ENUM('admin','data_entry','approver','reviewer','pcmed_reviewer','pcmed_approver') DEFAULT 'data_entry'",
    );
    await queryInterface.addColumn("users", "data_scope", {
      type: Sequelize.ENUM("own", "assigned", "all"),
      allowNull: false,
      defaultValue: "own",
    });
    await queryInterface.createTable("user_dad_assignments", {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      organization: { type: Sequelize.STRING, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("user_dad_assignments", ["user_id", "organization"], {
      unique: true,
      name: "user_dad_assignments_unique",
    });

    for (const table of RECORD_TABLES) {
      await q.query(`ALTER TABLE \`${table}\` MODIFY status ENUM(${STATUSES}) NOT NULL DEFAULT 'Pending'`);
      await queryInterface.addColumn(table, "pcmedReviewedBy", { type: Sequelize.STRING, allowNull: true });
      await queryInterface.addColumn(table, "pcmedReviewedById", { type: Sequelize.INTEGER, allowNull: true });
      await queryInterface.addColumn(table, "pcmedReviewedAt", { type: Sequelize.DATE, allowNull: true });
      await queryInterface.addColumn(table, "pcmedReviewComment", { type: Sequelize.TEXT, allowNull: true });
      await queryInterface.addColumn(table, "pcmedApprovedBy", { type: Sequelize.STRING, allowNull: true });
      await queryInterface.addColumn(table, "pcmedApprovedById", { type: Sequelize.INTEGER, allowNull: true });
      await queryInterface.addColumn(table, "pcmedApprovedAt", { type: Sequelize.DATE, allowNull: true });
      await queryInterface.addColumn(table, "pcmedApprovalComment", { type: Sequelize.TEXT, allowNull: true });
    }

    await q.query(`
      ALTER TABLE Notifications
      MODIFY event ENUM('created','reviewed','approved','viewed','returned','resubmitted',
        'sent_to_pcmed','pcmed_reviewed','pcmed_approved','pcmed_returned') NOT NULL
    `);

    await queryInterface.createTable("workflow_events", {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      entity_type: { type: Sequelize.STRING(20), allowNull: false },
      entity_id: { type: Sequelize.INTEGER, allowNull: false },
      organization: { type: Sequelize.STRING, allowNull: true },
      action: { type: Sequelize.STRING(30), allowNull: false },
      from_status: { type: Sequelize.STRING(30), allowNull: true },
      to_status: { type: Sequelize.STRING(30), allowNull: true },
      comment: { type: Sequelize.TEXT, allowNull: true },
      actor_id: { type: Sequelize.INTEGER, allowNull: true },
      actor_name: { type: Sequelize.STRING, allowNull: true },
      actor_role: { type: Sequelize.STRING(20), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("workflow_events", ["entity_type", "entity_id"], {
      name: "workflow_events_entity",
    });
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await queryInterface.dropTable("workflow_events");
    await q.query(`
      ALTER TABLE Notifications
      MODIFY event ENUM('created','reviewed','approved','viewed','returned','resubmitted') NOT NULL
    `);
    for (const table of RECORD_TABLES) {
      for (const column of [
        "pcmedReviewedBy",
        "pcmedReviewedById",
        "pcmedReviewedAt",
        "pcmedReviewComment",
        "pcmedApprovedBy",
        "pcmedApprovedById",
        "pcmedApprovedAt",
        "pcmedApprovalComment",
      ]) {
        await queryInterface.removeColumn(table, column);
      }
      // Records part-way through PCMED go back to DAD approval before the values are removed.
      await q.query(
        `UPDATE \`${table}\` SET status = 'Reviewed' WHERE status IN ('PendingPCMEDReview','PendingPCMEDApproval')`,
      );
      await q.query(`UPDATE \`${table}\` SET status = 'Returned' WHERE status = 'ReturnedByPCMED'`);
      await q.query(`ALTER TABLE \`${table}\` MODIFY status ENUM(${OLD_STATUSES}) NOT NULL DEFAULT 'Pending'`);
    }
    await queryInterface.dropTable("user_dad_assignments");
    await queryInterface.removeColumn("users", "data_scope");
    await q.query("UPDATE users SET role = 'reviewer' WHERE role IN ('pcmed_reviewer','pcmed_approver')");
    await q.query(
      "ALTER TABLE users MODIFY role ENUM('admin','data_entry','approver','reviewer') DEFAULT 'data_entry'",
    );
  },
};
