import sequelize from "../config/database.js";
import User from "../models/users.js";
import { Op } from "sequelize";
import { logWorkflowEvent } from "../utils/workflowLog.js";
import Organization from "../models/organization.model.js";
import { UserDadAssignment } from "../models/workflow.model.js";

// Add a new user (Admin only)
export const addUser = async (req, res, next) => {
  try {
    const {
      name,
      email,
      password,
      username,
      role,
      organization,
      designation,
      lastLogin,
    } = req.body;

    if (
      !name ||
      !email ||
      !password ||
      !username ||
      !organization ||
      !designation
    ) {
      const error = new Error("All fields are required");
      error.statusCode = 400;
      return next(error);
    }

    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      const error = new Error("User already exists");
      error.statusCode = 400;
      return next(error);
    }

    const user = await User.create({
      name,
      email,
      password,
      username,
      role,
      organization,
      designation,
      // PCMED officers and executives work across all DADs by default (an administrator
      // can narrow it).
      data_scope: ["pcmed_reviewer", "pcmed_approver", "minister", "deputy_minister", "chief_director"].includes(role)
        ? "all"
        : "own",
    });

    const { password: _, ...userData } = user.get({ plain: true });
    res.status(201).json({
      success: true,
      message: "User created successfully",
      user: userData,
    });
  } catch (error) {
    next(error);
  }
};

// Get all users (Admin only)
export const getAllUsers = async (req, res, next) => {
  try {
    // Query parameters
    const { page = 1, limit = 10, search = "" } = req.query;

    const offset = (page - 1) * limit;

    // Search filter (case-insensitive)
    const whereClause = search
      ? {
          [Op.or]: [
            { name: { [Op.like]: `%${search}%` } },
            { email: { [Op.like]: `%${search}%` } },
            { username: { [Op.like]: `%${search}%` } },
            { organization: { [Op.like]: `%${search}%` } },
            { designation: { [Op.like]: `%${search}%` } },
          ],
        }
      : {};

    // Fetch users with pagination and search
    const { count, rows: users } = await User.findAndCountAll({
      where: whereClause,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [["createdAt", "DESC"]],
    });

    res.status(200).json({
      success: true,
      count: users.length,
      totalUsers: count,
      currentPage: parseInt(page),
      totalPages: Math.ceil(count / limit),
      users,
    });
  } catch (error) {
    next(error);
  }
};

// Get a single user (Admin only)
export const getUserById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = await User.findByPk(id);

    if (!user) {
      const error = new Error("User not found");
      error.statusCode = 404;
      return next(error);
    }

    res.status(200).json({
      success: true,
      user,
    });
  } catch (error) {
    next(error);
  }
};

// Update user (Admin only)
export const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await User.findByPk(id);
    if (!user) {
      const error = new Error("User not found");
      error.statusCode = 404;
      return next(error);
    }

    await user.update(req.body);

    const { password: _, ...userData } = user.get({ plain: true });
    res.status(200).json({
      success: true,
      message: "User updated successfully",
      user: userData,
    });
  } catch (error) {
    next(error);
  }
};

// Delete user (Admin only)
export const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await User.findByPk(id);
    if (!user) {
      const error = new Error("User not found");
      error.statusCode = 404;
      return next(error);
    }

    await user.destroy();

    res.status(200).json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};


// GET /api/users/scopes?role= — users of a role with their data scope and assigned DADs.
export const listUserScopes = async (req, res, next) => {
  try {
    const where = req.query.role ? { role: String(req.query.role) } : {};
    const users = await User.findAll({
      where,
      attributes: ["id", "name", "username", "email", "role", "status", "organization", "designation", "data_scope"],
      include: [{ model: UserDadAssignment, as: "dadAssignments", attributes: ["organization"] }],
      order: [["name", "ASC"]],
    });
    res.status(200).json({
      success: true,
      data: users.map((u) => {
        const plain = u.get({ plain: true });
        const organizations = (plain.dadAssignments || []).map((a) => a.organization).sort();
        delete plain.dadAssignments;
        return { ...plain, organizations };
      }),
    });
  } catch (error) {
    next(error);
  }
};

// PUT /api/users/:id/scope  { scope: "own" | "assigned" | "all", organizations: [names] }
// Sets which DADs' records the user works on. The change is kept in the audit trail.
export const updateUserScope = async (req, res, next) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return next(Object.assign(new Error("User not found"), { statusCode: 404 }));
    const scope = String(req.body?.scope ?? "");
    if (!["own", "assigned", "all"].includes(scope)) {
      return next(Object.assign(new Error("Scope must be own, assigned or all"), { statusCode: 400 }));
    }
    const names = [...new Set((Array.isArray(req.body?.organizations) ? req.body.organizations : []).map(String))];
    if (scope === "assigned") {
      const known = await Organization.findAll({ where: { name: { [Op.in]: names } }, attributes: ["name"] });
      const unknown = names.filter((n) => !known.some((k) => k.name === n));
      if (unknown.length) {
        return next(Object.assign(new Error(`Unknown DAD: ${unknown.join(", ")}`), { statusCode: 400 }));
      }
    }
    const before = { scope: user.data_scope };
    await sequelize.transaction(async (transaction) => {
      await user.update({ data_scope: scope }, { transaction });
      await UserDadAssignment.destroy({ where: { user_id: user.id }, transaction });
      if (scope === "assigned" && names.length) {
        await UserDadAssignment.bulkCreate(
          names.map((organization) => ({ user_id: user.id, organization })),
          { transaction },
        );
      }
    });
    await logWorkflowEvent({
      entityType: "user",
      record: { id: user.id, organization: user.organization, status: scope },
      action: "data_scope_changed",
      from: before.scope,
      to: scope,
      comment: scope === "assigned" ? `Assigned DADs: ${names.join(", ") || "none"}` : null,
      user: req.user,
    });
    res.status(200).json({ success: true, message: "Data scope updated", data: { id: user.id, data_scope: scope, organizations: scope === "assigned" ? names.sort() : [] } });
  } catch (error) {
    next(error);
  }
};
