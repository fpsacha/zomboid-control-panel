import express from "express";
import { createLogger } from "../utils/logger.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import {
  requirePermission,
  listCapabilitiesGrouped,
  listRolesWithMemberCounts,
  createRole,
  updateRole,
  deleteRole,
} from "../services/permissions.js";

const log = createLogger("API:Permissions");
const router = express.Router();

// Every route here needs roles.manage: this is the matrix itself, not a
// tool that reads/writes anything the matrix grants access to.
router.use(requirePermission("roles.manage"));

function respondWithServiceError(res, error, fallbackMessage) {
  if (error && error.status) {
    const body = { error: error.message || fallbackMessage };
    if (error.code) body.code = error.code;
    if (error.params) body.params = sanitizeErrorParams(error.params);
    return res.status(error.status).json(body);
  }
  log.error(`${fallbackMessage}: ${error.message}`);
  return res.status(500).json({ error: sanitizeError(error.message) });
}

router.get("/capabilities", (req, res) => {
  res.json({ groups: listCapabilitiesGrouped() });
});

router.get("/roles", async (req, res) => {
  try {
    const roles = await listRolesWithMemberCounts();
    res.json({ roles });
  } catch (error) {
    respondWithServiceError(res, error, "Failed to list roles");
  }
});

router.post("/roles", async (req, res) => {
  try {
    const { name, capabilities } = req.body || {};
    const role = await createRole({ name, capabilities }, { actingUser: req.user });
    res.status(201).json({ success: true, role });
  } catch (error) {
    respondWithServiceError(res, error, "Failed to create role");
  }
});

router.put("/roles/:id", async (req, res) => {
  try {
    const { name, capabilities, confirmSelfCapabilityLoss } = req.body || {};
    const role = await updateRole(
      req.params.id,
      { name, capabilities },
      { actingUser: req.user, confirmSelfCapabilityLoss: confirmSelfCapabilityLoss === true },
    );
    res.json({ success: true, role });
  } catch (error) {
    respondWithServiceError(res, error, "Failed to update role");
  }
});

router.delete("/roles/:id", async (req, res) => {
  try {
    const reassignTo =
      typeof req.query.reassignTo === "string" ? req.query.reassignTo : undefined;
    const result = await deleteRole(req.params.id, {
      reassignTo,
      actingUser: req.user,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    respondWithServiceError(res, error, "Failed to delete role");
  }
});

export default router;
