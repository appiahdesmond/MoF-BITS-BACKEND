"use strict";

// Revised Work Plan: stable identities back to the Initial Work Plan, revision justifications,
// explicit removal/deferral decisions and reviewer observations. Nothing is deleted.
//
//   origin_id on outputs, activities, quarterly activities and cost items = the record of the
//   Initial Work Plan it was carried from (NULL = added during revision). Existing Revised
//   Work Plans are backfilled by position (they were copied in order).
//   work_plan_activities.revision_reason / reason_basis_cents: the activity-level justification
//   and the revised cost it was written for (a later cost change asks for it to be reviewed).
//   work_plan_revision_decisions: baseline records removed or deferred, with the reason.
//   work_plan_observations: review observations on the plan or a specific record.

const LEVELS = ["work_plan_outputs", "work_plan_activities", "work_plan_quarter_activities", "work_plan_cost_items"];

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    const t = await queryInterface.sequelize.transaction();
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction: t, replacements, type: S.QueryTypes.SELECT });
    const stamps = { created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false } };
    try {
      for (const table of LEVELS) await queryInterface.addColumn(table, "origin_id", { type: S.INTEGER, allowNull: true }, { transaction: t });
      await queryInterface.addColumn("work_plan_activities", "revision_reason", { type: S.TEXT, allowNull: true }, { transaction: t });
      await queryInterface.addColumn("work_plan_activities", "reason_basis_cents", { type: S.BIGINT, allowNull: true }, { transaction: t });
      await queryInterface.addColumn("work_plan_cost_items", "revision_reason", { type: S.TEXT, allowNull: true }, { transaction: t });

      await queryInterface.createTable(
        "work_plan_revision_decisions",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          work_plan_id: { type: S.INTEGER, allowNull: false, references: { model: "work_plans", key: "id" }, onDelete: "CASCADE" },
          record_type: { type: S.ENUM("output", "activity", "quarter", "item"), allowNull: false },
          origin_id: { type: S.INTEGER, allowNull: false },
          decision: { type: S.ENUM("removed", "deferred"), allowNull: false },
          reason: { type: S.TEXT, allowNull: true },
          created_by: { type: S.STRING, allowNull: true },
          created_by_id: { type: S.INTEGER, allowNull: true },
          ...stamps,
        },
        { transaction: t },
      );
      await queryInterface.addIndex("work_plan_revision_decisions", ["work_plan_id", "record_type", "origin_id"], { unique: true, name: "wp_decisions_unique", transaction: t });

      await queryInterface.createTable(
        "work_plan_observations",
        {
          id: { type: S.INTEGER, autoIncrement: true, primaryKey: true },
          work_plan_id: { type: S.INTEGER, allowNull: false, references: { model: "work_plans", key: "id" }, onDelete: "CASCADE" },
          record_type: { type: S.ENUM("plan", "output", "activity", "quarter", "item"), allowNull: false, defaultValue: "plan" },
          record_id: { type: S.INTEGER, allowNull: true },
          record_label: { type: S.STRING(300), allowNull: true },
          stage: { type: S.STRING(30), allowNull: false },
          text: { type: S.TEXT, allowNull: false },
          created_by: { type: S.STRING, allowNull: true },
          created_by_id: { type: S.INTEGER, allowNull: true },
          created_by_role: { type: S.STRING(40), allowNull: true },
          resolved_at: { type: S.DATE, allowNull: true },
          ...stamps,
        },
        { transaction: t },
      );

      // Backfill identities of Revised Work Plans activated before this change.
      const plans = await q("SELECT id, parent_plan_id FROM work_plans WHERE stage = 'Revised' AND parent_plan_id IS NOT NULL");
      const kids = (table, fk, parentId) => q(`SELECT id FROM ${table} WHERE ${fk} = ? ORDER BY ${table === "work_plan_quarter_activities" ? "quarter, " : ""}sort, id`, [parentId]);
      const link = async (table, fk, revParent, baseParent, next) => {
        const [rev, base] = await Promise.all([kids(table, fk, revParent), kids(table, fk, baseParent)]);
        for (let i = 0; i < Math.min(rev.length, base.length); i++) {
          await queryInterface.sequelize.query(`UPDATE ${table} SET origin_id = ? WHERE id = ? AND origin_id IS NULL`, { transaction: t, replacements: [base[i].id, rev[i].id] });
          if (next) await next(rev[i].id, base[i].id);
        }
      };
      for (const p of plans)
        await link("work_plan_outputs", "work_plan_id", p.id, p.parent_plan_id, (ro, bo) =>
          link("work_plan_activities", "output_id", ro, bo, (ra, ba) => link("work_plan_quarter_activities", "activity_id", ra, ba, (rq, bq) => link("work_plan_cost_items", "quarter_activity_id", rq, bq))),
        );
      await t.commit();
    } catch (error) {
      await t.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable("work_plan_observations");
    await queryInterface.dropTable("work_plan_revision_decisions");
    await queryInterface.removeColumn("work_plan_cost_items", "revision_reason");
    await queryInterface.removeColumn("work_plan_activities", "reason_basis_cents");
    await queryInterface.removeColumn("work_plan_activities", "revision_reason");
    for (const table of LEVELS) await queryInterface.removeColumn(table, "origin_id");
  },
};
