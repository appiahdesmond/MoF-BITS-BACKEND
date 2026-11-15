import User from "./models/users.js";
import sequelize from "./config/database.js";

const existing = await User.findOne({ where: { username: "tmpnat" } });
if (!existing) {
  await User.create({
    name: "Temp Nat",
    email: "tmpnat@example.com",
    password: "TempCheck1!",
    username: "tmpnat",
    role: "data_entry",
    status: "active",
    organization: "Institute of Accountancy Training",
    designation: "Tester",
  });
  console.log("CREATED");
} else {
  console.log("EXISTS", existing.id);
}

await sequelize.close();
