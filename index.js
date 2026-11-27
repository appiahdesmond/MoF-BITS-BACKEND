import express from "express";
import sequelize from "./config/database.js";
import cors from "cors";
import cookieParser from "cookie-parser";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandling.js";
import authRoute from "./routes/auth.route.js";
import userRoute from "./routes/user.route.js";
import expenditureRoute from "./routes/expenditure.route.js";
import reportRoute from "./routes/report.route.js";
import revenueRoute from "./routes/revenue.route.js";
import revenueReportRoute from "./routes/revenueReport.route.js";
import loadedDataRoute from "./routes/loadedData.route.js";
import budgetRoute from "./routes/budget.route.js";
import appropriationRoute from "./routes/appropriation.route.js";
import cashRoute from "./routes/cash.route.js";
import cashReportRoute from "./routes/cashReport.route.js";
import activityRoute from "./routes/activity.route.js";
import reallocationRoute from "./routes/reallocation.route.js";
import naturalAccountRoute from "./routes/naturalAccount.route.js";
import reallocationReportRoute from "./routes/reallocationReport.route.js";
import analyticsRoute from "./routes/analytics.route.js";
import notificationRoute from "./routes/notification.route.js";
import organizationRoute from "./routes/organization.route.js";
import rolesRoute from "./routes/roles.route.js";
import pcmedRoute from "./routes/pcmed.route.js";
import cashPlanRoute from "./routes/cashPlan.route.js";
import workPlanRoute from "./routes/workPlan.route.js";
import registerRoute from "./routes/register.route.js";
import budgetCeilingRoute from "./routes/budgetCeiling.route.js";
import { getCompliance } from "./controllers/compliance.controller.js";
import { protectRoutes } from "./middleware/routesProtect.js";
import { requirePage } from "./utils/pageAccess.js";
import { approvedOnlyUnlessPermitted } from "./utils/permissions.js";

const PORT = process.env.PORT || 7005;

const app = express();

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.use(
  cors({
    origin: ["http://localhost:5173", "https://mof-dads-bits.netlify.app"],
    credentials: true,
  }),
);


app.use(cookieParser());

//routes
app.use("/api/auth", authRoute);
app.use("/api/users", userRoute);
app.use("/api/expense", expenditureRoute);
app.use("/api/reports", protectRoutes, requirePage("reports"), approvedOnlyUnlessPermitted, reportRoute);
app.use("/api/revenue", revenueRoute);
app.use("/api/revenueReport", protectRoutes, requirePage("reports"), approvedOnlyUnlessPermitted, revenueReportRoute);
app.use("/api/loadedData", loadedDataRoute);
app.use("/api/budget", budgetRoute);
app.use("/api/appropriation", appropriationRoute);
app.use("/api/cash", cashRoute);
app.use("/api/cashReport", protectRoutes, requirePage("reports"), approvedOnlyUnlessPermitted, cashReportRoute);
app.use("/api/activity", activityRoute);
app.use("/api/reallocation", reallocationRoute);
app.use("/api/naturalAccount", protectRoutes, requirePage("reports"), approvedOnlyUnlessPermitted, naturalAccountRoute);
app.use("/api/reallocationReport", protectRoutes, requirePage("reports"), approvedOnlyUnlessPermitted, reallocationReportRoute);
app.use("/api/analytics", protectRoutes, approvedOnlyUnlessPermitted, analyticsRoute);
app.use("/api/notifications", notificationRoute);
app.use("/api/organizations", organizationRoute);
app.use("/api/roles", rolesRoute);
app.use("/api/pcmed", pcmedRoute);
app.use("/api/cash-plans", cashPlanRoute);
app.use("/api/work-plans", workPlanRoute);
app.use("/api/registers", registerRoute);
app.use("/api/budget-ceilings", budgetCeilingRoute);
app.get("/api/compliance", protectRoutes, requirePage("compliance"), getCompliance);

//middleware
app.use(notFound);
app.use(errorHandler);

const startServer = async () => {
  try {
    //Test the connection by trying to authenticate, Confirms the database is reachable and credentials are correct
    await sequelize.authenticate();
    console.log("Database connected");

    app.listen(PORT, () => {
      console.log(`App is listening on ${PORT}`);
    });
  } catch (err) {
    console.error("Startup failed:", err);
    //The process never exits silently
    process.exit(1);
  }
};

startServer();
