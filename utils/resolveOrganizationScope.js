import { seesAllDads } from "./dataScope.js";

export const resolveOrganizationScope = ({ user, organization }) => {
  // Users without a ministry-wide scope (administrators, data scope "all") are
  // always restricted to their own DAD.
  if (!seesAllDads(user)) {
    return {
      organization: user.organization,
      isAll: false,
    };
  }

  // Requesting ALL
  if (!organization || organization === "ALL") {
    return {
      organization: null, // null = no filter
      isAll: true,
    };
  }

  // Requesting one DAD
  return {
    organization,
    isAll: false,
  };
};
