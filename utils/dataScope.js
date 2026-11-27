// Which DADs' records a user works on (users.data_scope):
//   own      – the user's own organisation (DAD officers)
//   assigned – the DADs an administrator assigned (user_dad_assignments)
//   all      – every DAD
// Administrators always see every DAD.
import { UserDadAssignment } from "../models/workflow.model.js";

export async function dadScope(user) {
  if (!user) return { all: false, organizations: [] };
  if (user.role === "admin" || user.data_scope === "all") return { all: true, organizations: [] };
  if (user.data_scope === "assigned") {
    const rows = await UserDadAssignment.findAll({ where: { user_id: user.id }, attributes: ["organization"] });
    return { all: false, organizations: rows.map((r) => r.organization) };
  }
  return { all: false, organizations: user.organization ? [user.organization] : [] };
}

export const inScope = (scope, organization) => scope.all || scope.organizations.includes(organization);

/**
 * True when the user may view every DAD's data (dashboards, registers, reports):
 * administrators, and anyone whose data scope is "all".
 * Record ownership and workflow actions are checked separately.
 */
export const seesAllDads = (user) => user?.role === "admin" || user?.data_scope === "all";
