import { Router } from "express";
import {
  addUser,
  deleteUser,
  getAllUsers,
  getUserById,
  updateUser,
  listUserScopes,
  updateUserScope,
} from "../controllers/user.controller.js";
import { restrict } from "../middleware/restrict.js";
import { protectRoutes } from "../middleware/routesProtect.js";

const router = Router();

router.get("/", protectRoutes, restrict("admin"), getAllUsers);

// Data scope (which DADs a user works on), set under Roles & Permissions.
router.get("/scopes", protectRoutes, restrict("admin"), listUserScopes);
router.put("/:id/scope", protectRoutes, restrict("admin"), updateUserScope);

router.post("/", protectRoutes, restrict("admin"), addUser);

router.get("/:id", protectRoutes, restrict("admin"), getUserById);

router.put("/:id", protectRoutes, restrict("admin"), updateUser);

router.delete("/:id", protectRoutes, restrict("admin"), deleteUser);



export default router;

//protectRoutes, restrict("admin")
