import Router from "express";
import {
  changePassword,
  getUser,
  login,
  logout,
  refreshToken,
  registerUser,
  removeAvatar,
  updateAvatar,
  updateProfile,
} from "../controllers/auth.controller.js";
import { protectRoutes } from "../middleware/routesProtect.js";
import { restrict } from "../middleware/restrict.js";
import { upload } from "../middleware/uploadProfile.js";

const router = Router();

// Accounts are created by admins only (Console > Users); never open self-registration.
router.post("/register", protectRoutes, restrict("admin"), registerUser);

router.post("/login", login);

router.get("/me", getUser);

router.patch("/profile", protectRoutes, updateProfile);

router.post("/change-password",protectRoutes, changePassword);

router.patch("/upload-avatar", protectRoutes, upload.single("avatar"), updateAvatar);

router.patch("/remove-avatar", protectRoutes, removeAvatar);

router.get("/refresh", refreshToken);

router.post("/logout", logout);

export default router;

