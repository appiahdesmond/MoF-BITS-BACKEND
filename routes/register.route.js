import { Router } from "express";
import { protectRoutes } from "../middleware/routesProtect.js";
import { restrict } from "../middleware/restrict.js";
import * as c from "../controllers/workPlan.controller.js";

// Central registers maintained in System Management: Chart of Accounts (natural accounts)
// and the strategic framework (adopted objectives). Any signed-in user may read them;
// only administrators change them.
const router = Router();
for (const [path, kind] of [
  ["natural-accounts", "accounts"],
  ["objectives", "objectives"],
]) {
  router.get(`/${path}`, protectRoutes, c.listRegister(kind));
  router.post(`/${path}`, protectRoutes, restrict("admin"), c.createRegister(kind));
  router.put(`/${path}/:id`, protectRoutes, restrict("admin"), c.updateRegister(kind));
  router.delete(`/${path}/:id`, protectRoutes, restrict("admin"), c.deleteRegister(kind));
}
export default router;
