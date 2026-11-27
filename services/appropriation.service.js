import LoadedData from "../models/loadedData.js";
import { fn, col } from "sequelize";
import { seesAllDads } from "../utils/dataScope.js";

export async function getAppropriationData({
  year,
  sourceOfFunding,
  organization,
  user,
}) {
  const where = {
    year,
    ...(sourceOfFunding !== "ALL" && { sourceOfFunding }),
  };

  if (!seesAllDads(user)) {
    where.organization = user.organization;
  } else if (organization) {
    where.organization = organization;
  }

  return LoadedData.findAll({
    where,
    attributes: [
      "economicClassification",
      "sourceOfFunding",
      [fn("SUM", col("appropriation")), "totalAppropriation"],
    ],
    group: ["economicClassification", "sourceOfFunding"],
    raw: true,
  });
}
