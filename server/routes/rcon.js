import express from 'express';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:RCON');
import { getCommandHistory } from '../database/init.js';
import { PZ_COMMANDS } from '../utils/commands.js';
import {
  parseBoundedInteger,
  parseClampedInteger,
} from '../utils/queryNumbers.js';
import { sanitizeError } from '../utils/sanitize.js';
import { redactRconCommandSecrets } from '../utils/rconCommandRedaction.js';
import {
  testRconConnection,
  checkTcpReachable,
  RCON_UNREACHABLE_DETAIL,
  RCON_AUTH_FAILED_DETAIL,
  RCON_USER_ACTION_TIMEOUT_MS,
} from '../services/rcon.js';
import { requirePermission } from '../services/permissions.js';
import { ErrorCode } from '../utils/errorCodes.js';

const router = express.Router();

// Same shape as scheduler.js's own private requireCapabilityInline (not
// shared — each is small enough that a shared module would be more
// indirection than the six lines it saves): the /test route below chains a
// second, STATIC requirePermission() because it always needs both
// capabilities, but /connect's second requirement is conditional on parsed
// body content (see its own comment), which a static chain can't express.
async function requireCapabilityInline(capability, req, res) {
  let passed = false;
  await requirePermission(capability)(req, res, () => {
    passed = true;
  });
  return passed;
}

// Mixed, not file-wide: /execute runs an ARBITRARY raw RCON command with no
// structural validation beyond a length cap — meaningfully more powerful
// than the specific, validated actions in players.js (kick/ban/etc.), and
// includes things like `quit` that can shut the server down. That, plus
// connection lifecycle (/connect, /disconnect, /test — reconfigures which
// RCON endpoint the panel talks to), are admin+technician only, NOT
// moderator: a moderator doing player moderation should use players.js's
// structured endpoints, not an open console. Read-only status/reference
// routes below (/status, /health, /commands, /commands/:category) stay open
// to every logged-in role deliberately — nothing sensitive is returned and
// a moderator plausibly wants to see RCON status or the command reference.
//
// /history is NOT in that group, despite looking like one more read-only
// reference route: it returns the verbatim command_history log, and
// logCommand() (database/init.js) stores the exact command STRING that was
// sent, unredacted -- including, e.g., `adduser "player" "password"` from
// the whitelist-add flow (a real PZ join password) or anything typed into
// this file's own /execute console. Leaving it ungated meant any logged-in
// role -- a moderator included, who never holds rcon.execute -- could read
// every admin/technician's past RCON console session and every whitelist
// password ever set, through an endpoint whose neighbors really are
// harmless. Gated the same as /execute/connect/disconnect/test.

function validateTestInput(host, port, password) {
  if (typeof host !== 'string' || host.length > 255 || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    return 'Invalid host format';
  }
  const portNum = parseBoundedInteger(port, null, 1, 65535);
  if (portNum === null) {
    return 'Invalid port (1-65535)';
  }
  if (password !== undefined && (typeof password !== 'string' || password.length > 256)) {
    return 'Invalid password format';
  }
  return null;
}

// Execute raw RCON command
router.post('/execute', requirePermission('rcon.execute'), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const command = req.body?.command;
    // Redact BEFORE truncating: the redaction regex needs the password
    // argument's closing quote to match (rconCommandRedaction.js), which a
    // 100-char cut partway through the password would strip, leaving a
    // partial cleartext fragment logged instead of a redacted one.
    log.info(`POST /execute: ${typeof command === 'string' ? redactRconCommandSecrets(command).substring(0, 100) : ''}`);

    if (!command) {
      return res.status(400).json({ error: 'Command is required', code: ErrorCode.RCON_COMMAND_REQUIRED });
    }

    // Validate command type and length
    if (typeof command !== 'string' || command.length > 2000) {
      return res.status(400).json({ error: 'Invalid command (max 2000 characters)', code: ErrorCode.RCON_COMMAND_INVALID });
    }
    
    const result = await rconService.execute(command);

    // Emit to connected clients. Redact both fields before broadcasting --
    // this is the FULL, untruncated command reaching every socket in the
    // "rcon-live" room, unlike the 100-char log.info above, and
    // command_history (database/init.js's logCommand) already redacts both
    // command and response for the identical reason: `response` is
    // defense-in-depth in case a verbose RCON reply ever echoes the command
    // it's replying to. Targets "rcon-live" (gated rcon.execute in
    // index.js), not "logs" (gated the broader diagnostics.manage) -- moved
    // 2026-08-31 bug hunt: this is the same class of content /rcon/history
    // deliberately gates on rcon.execute alone, per this file's own header
    // comment above, and the live broadcast must not reopen that through a
    // different, broader capability.
    const io = req.app.get('io');
    if (io) io.to('rcon-live').emit('rcon:response', {
      command: redactRconCommandSecrets(command),
      response: redactRconCommandSecrets(result.response || result.error),
      success: result.success,
      timestamp: new Date().toISOString()
    });
    
    res.json(result);
  } catch (error) {
    log.error(`RCON execute failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get RCON connection status
router.get('/status', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const config = rconService.getConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Connect to RCON
router.post('/connect', requirePermission('rcon.execute'), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, error: 'Request body must be an object' });
    }
    const rconService = req.app.get('rconService');
    const { host, port, password } = req.body;
    log.info(`POST /connect (host=${host || 'default'}, port=${port || 'default'}, password=${password ? '***' : 'none'})`);

    // Overriding host/port/password here does exactly what /test's own
    // servers.manage gate exists to prevent -- makes the panel open a raw
    // TCP connection (and RCON auth handshake) against ANY host the caller
    // names -- except worse: updateConfig() below PERSISTS the override on
    // the shared RconService singleton (redirecting every other operator's
    // subsequent rcon.execute traffic too, not just this request), and a
    // caller who omits `password` gets the EXISTING real password sent to
    // their chosen host for free (updateConfig() only overwrites fields
    // that were actually provided). Not reachable via either seeded role
    // that holds rcon.execute (admin, technician both also hold
    // servers.manage in DEFAULT_ROLE_CAPABILITIES) -- but a custom role
    // built with rcon.execute and not servers.manage, which the
    // roles.manage-gated custom-role feature lets an operator create as
    // documented, could silently exfiltrate the real RCON password and
    // hijack the live connection through it. Same class as the
    // auth.js:507/544 escalation card (2026-09-06). Same fix as /test
    // (2026-08-27 CodeQL triage, js/request-forgery #26/#333): requires
    // servers.manage too, via the inline helper above rather than a static
    // chained requirePermission() like /test uses, because this second
    // requirement is conditional on whether the request actually names an
    // override -- a plain reconnect to the already-configured,
    // already-trusted target (no host/port/password in the body) stays
    // reachable on rcon.execute alone, the same routine action it always
    // was.
    const overridesConnectionTarget =
      host !== undefined || port !== undefined || password !== undefined;
    if (overridesConnectionTarget && !(await requireCapabilityInline('servers.manage', req, res))) {
      return;
    }

    // Validate host format if provided (only alphanumeric, dots, hyphens)
    if (host !== undefined) {
      if (typeof host !== 'string' || host.length > 255 || !/^[a-zA-Z0-9.-]+$/.test(host)) {
        return res.status(400).json({ success: false, error: 'Invalid host format', code: ErrorCode.RCON_INVALID_HOST });
      }
    }

    // Validate port if provided
    let normalizedPort;
    if (port !== undefined) {
      normalizedPort = parseBoundedInteger(port, null, 1, 65535);
      if (normalizedPort === null) {
        return res.status(400).json({ success: false, error: 'Invalid port (1-65535)', code: ErrorCode.RCON_INVALID_PORT });
      }
    }

    // Validate password if provided
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length > 256) {
        return res.status(400).json({ success: false, error: 'Invalid password format', code: ErrorCode.RCON_INVALID_PASSWORD });
      }
    }
    
    if (overridesConnectionTarget) {
      rconService.updateConfig(host, normalizedPort, password);
    }

    let connected;
    try {
      connected = await rconService.connect();
    } catch {
      // rconService.connect() throws for some failures (e.g. authenticate()
      // rejecting) and resolves false for others (e.g. the port never opened)
      // -- both just mean "did not connect" here. Which one it was gets
      // reclassified by the reachability probe below, the same way /test
      // classifies it, rather than by sniffing this error's message.
      connected = false;
    }

    if (connected) {
      return res.json({ success: true, message: 'Connected to RCON' });
    }

    // Reused from /api/rcon/test (below): same probe, same two canonical
    // detail strings, so the dashboard's reconnect action -- the path a
    // user hits FIRST -- tells "never reachable" apart from "reachable, but
    // the password is wrong" exactly as well as the Servers page already
    // does, instead of the one generic message this used to return for both.
    const { host: configuredHost, port: configuredPort } = rconService.getConfig();
    const reachable = await checkTcpReachable(configuredHost, configuredPort, RCON_USER_ACTION_TIMEOUT_MS);
    if (!reachable) {
      return res.status(503).json({
        success: false,
        error: RCON_UNREACHABLE_DETAIL,
        code: ErrorCode.RCON_CONNECT_UNREACHABLE,
      });
    }
    return res.status(503).json({
      success: false,
      error: RCON_AUTH_FAILED_DETAIL,
      code: ErrorCode.RCON_CONNECT_AUTH_FAILED,
    });
  } catch (error) {
    log.error(`RCON connect failed: ${error.message}`);
    const rconService = req.app.get('rconService');
    const friendlyError = rconService.getUserFriendlyError(error.message);
    res.status(500).json({ success: false, error: friendlyError });
  }
});

// Test arbitrary RCON credentials without applying them — lets the UI
// validate host/port/password before the user saves a server's settings.
// requirePermission('rcon.execute') ALONE used to be the only gate here,
// but this route makes the panel open a raw TCP connection (and attempt an
// RCON auth handshake) against ANY host/port the caller names — CodeQL
// js/request-forgery #26/#333 (2026-08-27 CodeQL triage): rcon.execute's
// own description ("execute arbitrary console commands" against the
// configured server) never promised "connect to arbitrary hosts," so a
// role holding only rcon.execute could use this endpoint as a blind
// internal-network TCP prober. Chained a second requirePermission() rather
// than an inline check since the requirement is static, not conditional on
// request content (unlike scheduler.js's requireCapabilityInline, which
// exists specifically because ITS second capability depends on parsed
// body content) — operator's own framing: you need the power to ADD a
// server to be allowed to test one, so servers.manage is the natural
// second gate, not a new capability. Confirmed both capabilities'
// descriptions still read correctly after this change: rcon.execute no
// longer implies arbitrary-host reach, and servers.manage's "add, edit...
// a server entry" already covers testing a connection as part of that
// workflow — neither needed a text change.
router.post('/test', requirePermission('rcon.execute'), requirePermission('servers.manage'), async (req, res) => {
  try {
    const { host, port, password } = req.body || {};
    // host/port only, for audit — NEVER the password. Run through the
    // shared redaction helper as defense-in-depth (the same discipline
    // every other RCON log line in this file uses) even though this
    // specific template can't currently produce an adduser-shaped match —
    // six separate RCON credential leak sites were found and fixed
    // tonight, and a bespoke "just don't interpolate password" line is
    // exactly the kind of ad-hoc logic that produced those.
    log.info(redactRconCommandSecrets(`POST /test (host=${host || 'none'}, port=${port || 'none'})`));

    const validationError = validateTestInput(host, port, password);
    if (validationError) {
      return res.status(400).json({ success: false, error: 'invalid_input', detail: validationError });
    }

    const result = await testRconConnection({
      host,
      port: parseBoundedInteger(port, null, 1, 65535),
      password,
    });
    res.json(result);
  } catch (error) {
    log.error(`RCON test failed: ${error.message}`);
    res.status(500).json({ success: false, error: 'internal_error', detail: sanitizeError(error.message) });
  }
});

// Health check - test if connection is actually alive
router.get('/health', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const health = await rconService.healthCheck();
    if (health.healthy) {
      res.json({ success: true, ...health });
    } else {
      res.status(503).json({ success: false, ...health });
    }
  } catch (error) {
    res.status(500).json({ success: false, reason: sanitizeError(error.message) });
  }
});

// Disconnect from RCON
router.post('/disconnect', requirePermission('rcon.execute'), async (req, res) => {
  try {
    log.info('POST /disconnect');
    const rconService = req.app.get('rconService');
    await rconService.disconnect();
    res.json({ success: true, message: 'Disconnected from RCON' });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get command history
router.get('/history', requirePermission('rcon.execute'), async (req, res) => {
  try {
    const limit = parseClampedInteger(req.query.limit, 100, 1, 1000);
    const history = await getCommandHistory(limit);
    res.json({ history });
  } catch (error) {
    log.error(`Failed to get command history: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get available commands
router.get('/commands', (req, res) => {
  res.json({ commands: PZ_COMMANDS });
});

// Get commands by category
router.get('/commands/:category', (req, res) => {
  const { category } = req.params;
  const filtered = Object.entries(PZ_COMMANDS)
    .filter(([_, cmd]) => cmd.category === category)
    .reduce((acc, [key, cmd]) => {
      acc[key] = cmd;
      return acc;
    }, {});
  
  res.json({ commands: filtered });
});

export default router;
