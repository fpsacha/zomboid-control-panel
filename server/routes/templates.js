import express from "express";
import { createLogger } from "../utils/logger.js";
import { sanitizeError } from "../utils/sanitize.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { requirePermission } from "../services/permissions.js";
import { getActiveServer, getServer } from "../database/init.js";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "../services/lifecycleCoordinator.js";
import { checkSpecificServerStopped } from "./server.js";
import {
  listTemplates,
  listHiddenBuiltinTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
  unhideTemplate,
  exportTemplate,
  importTemplate,
  previewTemplate,
  applyTemplate,
} from "../services/templateService.js";

const log = createLogger("API:Templates");
const router = express.Router();

router.get("/", async (req, res) => {
  try {
    res.json({ templates: await listTemplates() });
  } catch (error) {
    log.error(`Failed to list templates: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Registered before /:id so the literal segment "hidden" is never captured
// as a template id. Gated on templates.manage -- same permission as
// restoring one (POST /:id/unhide below) and deleting one -- an operator
// who cannot manage templates has no use for the ids of ones that are
// hidden.
router.get("/hidden", requirePermission("templates.manage"), async (req, res) => {
  try {
    res.json({ templates: await listHiddenBuiltinTemplates() });
  } catch (error) {
    log.error(`Failed to list hidden templates: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const template = await getTemplate(req.params.id);
    if (!template) {
      return res
        .status(404)
        .json({ error: "Template not found", code: ErrorCode.SIM_TEMPLATE_NOT_FOUND });
    }
    res.json({ template });
  } catch (error) {
    log.error(`Failed to get template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await saveTemplate(req.body);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    log.error(`Failed to create template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/import", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await importTemplate(req.body?.template ?? req.body);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    log.error(`Failed to import template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/:id/export", async (req, res) => {
  try {
    const result = await exportTemplate(req.params.id);
    if (!result.success) return res.status(404).json(result);
    res
      .set("Content-Disposition", `attachment; filename="${req.params.id}.json"`)
      .json(result.template);
  } catch (error) {
    log.error(`Failed to export template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/:id/preview", async (req, res) => {
  try {
    const { serverId } = req.body || {};
    if (!serverId) {
      return res
        .status(400)
        .json({ error: "serverId is required", code: ErrorCode.SIM_TEMPLATE_SERVER_ID_REQUIRED });
    }

    const result = await previewTemplate(req.params.id, serverId);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    log.error(`Failed to preview template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/:id/apply", requirePermission("templates.manage"), async (req, res) => {
  // lifecycle-lock-set sweep, 2026-09-07: the active-server branch below
  // checks getServerProcessDetails() once, then applyTemplate() does real
  // config-file I/O with no lock held. A concurrent /start landing in that
  // window launches the JVM reading a partially-written config. Same fix
  // as /wipe, /delete-files, and chunks.js's delete-chunks/delete-region:
  // take the process-wide lifecycleCoordinator lock for the whole handler.
  // The non-active-server branch below always fails closed unconditionally
  // regardless of this lock (it never reaches applyTemplate()), so holding
  // the lock for that branch too is harmless, just a brief no-op hold.
  const lifecycleLock = acquireLifecycleLock("template-apply");
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  try {
    const { serverId, options } = req.body || {};
    if (!serverId) {
      return res
        .status(400)
        .json({ error: "serverId is required", code: ErrorCode.SIM_TEMPLATE_SERVER_ID_REQUIRED });
    }

    const activeServer = await getActiveServer();
    if (String(activeServer?.id) === String(serverId)) {
      const serverManager = req.app.get("serverManager");
      if (!serverManager?.getServerProcessDetails) {
        return res.status(503).json({
          error: "Unable to verify server state",
          code: ErrorCode.SIM_TEMPLATE_APPLY_STATE_UNKNOWN,
        });
      }
      try {
        // split-derivation sweep, 2026-09-07 (same class as /wipe's
        // pre-fix bug, 5c2e73e9): the ID-equality check above reads
        // activeServer fresh, but serverManager.getServerProcessDetails()
        // internally calls the GUARDED loadConfig() -- a no-op once
        // serverManager has loaded ANY server's config -- so passing the
        // equality check does not guarantee serverManager's own cached
        // identity actually matches activeServer yet (e.g. immediately
        // after a /activate switch). Force a real reload first so the
        // running-check below examines the same server the ID check just
        // verified, not whatever serverManager was last pointed at.
        await serverManager.reloadConfig();
        // getServerProcessDetails(), not checkServerRunning() -- the latter
        // discards the scan's own scanFailed flag and returns a plain
        // boolean, so a scan that completed but couldn't determine the
        // server's state (timeout, PowerShell/exec error) came back
        // indistinguishable from "confirmed stopped" and let this apply
        // proceed. Same fail-open class already fixed at /wipe,
        // /delete-files, chunks.js's delete-chunks/delete-region, and
        // backup.js's restore.
        const details = await serverManager.getServerProcessDetails();
        if (details.scanFailed) {
          return res.status(503).json({
            error: "Unable to verify server state",
            code: ErrorCode.SIM_TEMPLATE_APPLY_STATE_UNKNOWN,
          });
        }
        if (details.running) {
          return res.status(409).json({
            error: "Stop the server before applying a template",
            code: ErrorCode.SIM_TEMPLATE_APPLY_SERVER_RUNNING,
          });
        }
      } catch (error) {
        log.warn(`Could not verify server state before template apply: ${error.message}`);
        return res.status(503).json({
          error: "Unable to verify server state",
          code: ErrorCode.SIM_TEMPLATE_APPLY_STATE_UNKNOWN,
        });
      }
    } else {
      // is-running-enumeration sweep, 2026-09-08: this branch used to refuse
      // outright for any non-active server (2026-08-24, conv-template-privesc)
      // because no cross-server process detection existed yet -- serverManager
      // is bound to one server by name and has no way to probe a different,
      // non-active server's process state on its own. That capability now
      // exists: checkSpecificServerStopped() (routes/server.js) does a
      // host-wide scan and attributes it to a SPECIFIC target server via
      // scoreServerProcessOwnership(), exactly the same convention already
      // used to fix /delete-files' identical cross-server gap. Reuses it
      // here rather than duplicating it -- and still fails closed exactly
      // like before on anything it can't confirm (SERVER_STATE_UNKNOWN),
      // just no longer refuses a normal two-profile workflow (server A
      // running and active, template applied to configured-but-inactive
      // server B) that IS safe to verify.
      const targetServer = await getServer(serverId);
      if (!targetServer) {
        return res.status(404).json({
          error: "Server not found",
          code: ErrorCode.SIM_TEMPLATE_SERVER_NOT_FOUND,
        });
      }
      const notStoppedError = await checkSpecificServerStopped(
        targetServer,
        "applying a template to it",
      );
      if (notStoppedError) {
        const isRunningConflict = notStoppedError.body?.code === ErrorCode.WIPE_SERVER_RUNNING;
        return res.status(isRunningConflict ? 409 : notStoppedError.status).json({
          error: isRunningConflict
            ? "Stop the server before applying a template"
            : notStoppedError.body.error,
          code: isRunningConflict
            ? ErrorCode.SIM_TEMPLATE_APPLY_SERVER_RUNNING
            : ErrorCode.SIM_TEMPLATE_APPLY_STATE_UNKNOWN,
        });
      }
    }

    const result = await applyTemplate(req.params.id, serverId, options || {});
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    log.error(`Failed to apply template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    lifecycleLock.release();
  }
});

router.delete("/:id", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await deleteTemplate(req.params.id);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    log.error(`Failed to delete template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/:id/unhide", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await unhideTemplate(req.params.id);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    log.error(`Failed to unhide template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
