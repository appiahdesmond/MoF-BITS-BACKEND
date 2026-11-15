import sequelize from "./config/database.js";
import LoadedData from "./models/loadedData.js";

const [rows] = await sequelize.query(`
  SELECT organization, economicClassification, sourceOfFunding,
         COUNT(*) AS n, COUNT(DISTINCT naturalAccount) AS accounts
  FROM loadeddata
  GROUP BY organization, economicClassification, sourceOfFunding
  ORDER BY organization, economicClassification
`);
console.log("LOADED", JSON.stringify(rows, null, 2));

const [users] = await sequelize.query(
  "SELECT id, name, username, organization, role FROM users",
);
console.log("USERS", JSON.stringify(users, null, 2));

try {
  const results = await LoadedData.findAll({
    attributes: ["naturalAccount"],
    where: {
      organization: "Institute of Accountancy Training",
      economicClassification: "Goods and Services",
      sourceOfFunding: "GOG",
    },
    group: ["naturalAccount"],
  });
  console.log(
    "QUERY_OK",
    results.length,
    results.slice(0, 5).map((row) => row.naturalAccount),
  );
} catch (error) {
  console.log("QUERY_FAIL", error.message);
}

await sequelize.close();
