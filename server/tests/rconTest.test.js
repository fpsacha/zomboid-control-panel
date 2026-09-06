import { describe, expect, it, vi } from 'vitest';
import net from 'net';
// Must come before the `router` import below: vi.mock('../database/init.js')
// is hoisted above every import, but its factory still runs the first time
// something actually imports that module -- which happens transitively the
// moment `router` (routes/rcon.js -> services/rcon.js -> database/init.js)
// is imported. If mockGetRoleByName's own import statement is still below
// that point in source order, the factory closes over an as-yet-unbound
// import and throws "Cannot access '...' before initialization" instead of
// a clean mock.
import { mockGetRoleByName } from './helpers/mockPermissionsDb.js';
import { testRconConnection, RCON_UNREACHABLE_DETAIL } from '../services/rcon.js';
import router from '../routes/rcon.js';
import { ErrorCode } from '../utils/errorCodes.js';

// Wraps mockGetRoleByName (admin/technician/moderator, matching the real
// seeded DEFAULT_ROLE_CAPABILITIES) so the escalation tests below can layer
// in a SYNTHETIC custom role too, via mockResolvedValueOnce -- both seeded
// roles that hold rcon.execute (admin, technician) ALREADY hold
// servers.manage as well, so neither can stand in for "a role with
// rcon.execute but not servers.manage" the way an operator-built custom
// role legitimately could (this is the same shape as the auth.js:507/544
// escalation card: a capability the matrix lets an operator delegate on its
// own, whose real reach isn't obvious from its catalogue description).
const getRoleByNameMock = vi.fn(mockGetRoleByName);

// sweep-round2 (2026-09-06): POST /connect's real handler now calls
// requireCapabilityInline('servers.manage', req, res) itself when the
// request overrides host/port/password (see routes/rcon.js's own comment on
// that route -- same escalation class as /test's servers.manage gate,
// closed the same way). Unlike the router-level requirePermission('rcon.execute')
// gate this file's getConnectHandler()/getTestHandler() helpers already
// bypass by grabbing only the LAST stack entry, this check lives INSIDE the
// handler body, so it's not bypassed the same way -- any test below that
// sends an override (host/port/password) needs a req.user whose role
// resolves to something holding servers.manage, or the new gate now
// (correctly) refuses it before touching updateConfig.
vi.mock('../database/init.js', () => ({
  getRoleByName: (name) => getRoleByNameMock(name),
}));

function createResponse() {
  const response = {};
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
}

function getTestHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === '/test' && entry.route.methods.post,
  );
  // LAST entry, not the first: requireRole('admin', 'technician') is now
  // ahead of the real handler in this route's stack (role sweep), so index
  // 0 would grab the role-gate middleware instead of the route logic this
  // test actually exercises.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getConnectHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === '/connect' && entry.route.methods.post,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getHandler(path) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods.post,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe('testRconConnection', () => {
  it('returns unreachable when the TCP connection cannot be established', async () => {
    // Nothing listens on this loopback port in the test environment, so the
    // connection is refused (or times out) rather than authenticating.
    const result = await testRconConnection({
      host: '127.0.0.1',
      port: 39822,
      password: 'whatever',
      timeoutMs: 1000,
    });
    expect(result).toEqual({
      success: false,
      error: 'unreachable',
      detail: 'Unreachable: check host and port',
    });
  });

  it('returns auth_failed when TCP connects but RCON auth never completes', async () => {
    // A bare TCP server that accepts the connection but never speaks the
    // RCON protocol -- authenticate() times out and rejects, exercising the
    // auth_failed branch without needing a real RCON server.
    const server = net.createServer((socket) => socket.on('data', () => {}));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const result = await testRconConnection({
        host: '127.0.0.1',
        port,
        password: 'wrong-password',
        timeoutMs: 300,
      });
      expect(result).toEqual({
        success: false,
        error: 'auth_failed',
        detail: 'Authentication failed: check RCON password',
      });
    } finally {
      server.close();
    }
  });
});

describe('POST /api/rcon/test route validation', () => {
  it('rejects an invalid host format with 400', async () => {
    const res = createResponse();
    await getTestHandler()(
      { body: { host: 'not a host!', port: 27015, password: 'x' } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'invalid_input',
      detail: 'Invalid host format',
    });
  });

  it('rejects an out-of-range port with 400', async () => {
    const res = createResponse();
    await getTestHandler()(
      { body: { host: '127.0.0.1', port: 99999, password: 'x' } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.detail).toBe('Invalid port (1-65535)');
  });

  it('rejects a port with trailing junk instead of accepting its numeric prefix', async () => {
    const res = createResponse();
    await getTestHandler()(
      { body: { host: '127.0.0.1', port: '27015junk', password: 'x' } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.detail).toBe('Invalid port (1-65535)');
  });

  it('reports unreachable for a closed local port via the real handler', async () => {
    const res = createResponse();
    await getTestHandler()(
      { body: { host: '127.0.0.1', port: 39822, password: 'x' } },
      res,
    );
    expect(res.body).toEqual({
      success: false,
      error: 'unreachable',
      detail: 'Unreachable: check host and port',
    });
  });
});

describe('POST /api/rcon/connect route updates', () => {
  it('applies an explicitly empty password instead of retaining the old one', async () => {
    const updateConfig = vi.fn();
    const connect = vi.fn(async () => false);
    const res = createResponse();

    await getConnectHandler()(
      {
        body: { password: '' },
        // An empty-string password is still an override (password !==
        // undefined), so this now needs to clear the new servers.manage
        // inline gate -- any role holding it (admin here) works, the test
        // isn't about which one.
        user: { role: 'admin' },
        app: {
          // Mirrors the real RconService (services/rcon.js) enough to
          // survive the unreachable-vs-auth-failed classification a failed
          // connect() falls through to: getConfig() for the reachability
          // re-probe, getUserFriendlyError() for the outer catch's
          // fallback. A mock missing either one crashes here instead of in
          // production -- exactly what happened when this test's mock went
          // stale against a real /connect change; see
          // routeRoleSweep.test.js:298 for the same lesson learned earlier.
          get: () => ({
            updateConfig,
            connect,
            getConfig: () => ({ host: '127.0.0.1', port: 39822 }),
            getUserFriendlyError: () => 'stub error',
          }),
        },
      },
      res,
    );

    // The behaviour this test is named for: an explicitly empty password is
    // passed through, not dropped for being falsy.
    expect(updateConfig).toHaveBeenCalledWith(undefined, undefined, '');
    // 39822: nothing listens there in the test environment (same convention
    // as this file's other tests above), so the failed connect() above is
    // deliberately classified as unreachable -- not just "didn't crash".
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: RCON_UNREACHABLE_DETAIL,
      code: ErrorCode.RCON_CONNECT_UNREACHABLE,
    });
  });

  it('returns a client error for a missing body', async () => {
    const updateConfig = vi.fn();
    const res = createResponse();

    await getConnectHandler()(
      {
        body: null,
        app: { get: () => ({ updateConfig, connect: vi.fn() }) },
      },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(updateConfig).not.toHaveBeenCalled();
  });
});

// sweep-round2 (2026-09-06): POST /connect let a caller who holds
// rcon.execute WITHOUT servers.manage redirect the shared RconService
// singleton's live connection to ANY host/port THEY name, via the exact
// same shape /test's own servers.manage gate already exists to prevent
// (2026-08-27 CodeQL triage, js/request-forgery #26/#333) -- except worse
// here: updateConfig() PERSISTS the override for every other operator's
// subsequent rcon.execute traffic, and omitting `password` keeps the
// EXISTING real password, which then gets sent in the RCON auth handshake
// to the attacker's chosen host. Neither seeded role that holds rcon.execute
// (admin, technician) can demonstrate this -- both already hold
// servers.manage too in DEFAULT_ROLE_CAPABILITIES -- so the "refuses" tests
// below use a SYNTHETIC custom role shaped the way an operator's own
// roles.manage-gated custom-role feature could legitimately build one:
// rcon.execute granted, servers.manage not. Not reachable on a default
// install out of the box, same caveat as the auth.js:507/544 escalation
// card -- reachable the moment an operator uses the delegation feature as
// documented, which is exactly the scenario CAPABILITIES's own
// operator-facing description of rcon.execute ("execute arbitrary console
// commands") gives no hint it doesn't also cover.
describe('POST /api/rcon/connect -- overriding host/port/password requires servers.manage, not just rcon.execute', () => {
  const RCON_ONLY_CUSTOM_ROLE = { name: 'rcon-operator', capabilities: ['rcon.execute'] };

  function makeOverrideReq(body, role, rconServiceOverrides = {}) {
    // The SAME object every call, not a fresh literal per get() -- the
    // route handler calls req.app.get('rconService') once internally, and
    // assertions below call req.app.get() again to reach it; a `get` that
    // built a new object each time would hand each caller a DIFFERENT mock
    // instance, so an assertion on "was updateConfig called" would always
    // see zero calls no matter what the route actually did.
    const rconService = {
      updateConfig: vi.fn(),
      connect: vi.fn(async () => true),
      getConfig: () => ({ host: '127.0.0.1', port: 27015 }),
      getUserFriendlyError: () => 'stub error',
      ...rconServiceOverrides,
    };
    return {
      body,
      user: role ? { role } : undefined,
      app: { get: () => rconService },
    };
  }

  it('refuses a host override from a custom role holding rcon.execute but not servers.manage -- the exploit this closes', async () => {
    getRoleByNameMock.mockResolvedValueOnce(RCON_ONLY_CUSTOM_ROLE);
    const res = createResponse();
    const req = makeOverrideReq({ host: 'attacker.example.com' }, 'rcon-operator');
    const rconService = req.app.get();

    await getConnectHandler()(req, res);

    expect(res.statusCode).toBe(403);
    expect(rconService.updateConfig).not.toHaveBeenCalled();
    expect(rconService.connect).not.toHaveBeenCalled();
  });

  it('refuses a password-only override (the "keep the existing host, exfiltrate the existing password" shape) from rcon.execute alone', async () => {
    getRoleByNameMock.mockResolvedValueOnce(RCON_ONLY_CUSTOM_ROLE);
    const res = createResponse();
    const req = makeOverrideReq({ password: 'whatever' }, 'rcon-operator');
    const rconService = req.app.get();

    await getConnectHandler()(req, res);

    expect(res.statusCode).toBe(403);
    expect(rconService.updateConfig).not.toHaveBeenCalled();
  });

  it('allows the same host override for a caller who holds servers.manage (admin)', async () => {
    const res = createResponse();
    const req = makeOverrideReq({ host: '10.0.0.5' }, 'admin');
    const rconService = req.app.get();

    await getConnectHandler()(req, res);

    expect(rconService.updateConfig).toHaveBeenCalledWith('10.0.0.5', undefined, undefined);
    expect(res.body).toEqual({ success: true, message: 'Connected to RCON' });
  });

  it('a seeded technician (rcon.execute AND servers.manage by default) can also override -- the fix does not regress the common case', async () => {
    const res = createResponse();
    const req = makeOverrideReq({ port: 27016 }, 'technician');
    const rconService = req.app.get();

    await getConnectHandler()(req, res);

    expect(rconService.updateConfig).toHaveBeenCalledWith(undefined, 27016, undefined);
    expect(res.body).toEqual({ success: true, message: 'Connected to RCON' });
  });

  it('does NOT require servers.manage for a plain reconnect with no override -- the rcon-only custom role still works for that, the routine case is unaffected', async () => {
    getRoleByNameMock.mockResolvedValueOnce(RCON_ONLY_CUSTOM_ROLE);
    const res = createResponse();
    const req = makeOverrideReq({}, 'rcon-operator');
    const rconService = req.app.get();

    await getConnectHandler()(req, res);

    expect(res.statusCode).not.toBe(403);
    expect(rconService.updateConfig).not.toHaveBeenCalled();
    expect(rconService.connect).toHaveBeenCalled();
    expect(res.body).toEqual({ success: true, message: 'Connected to RCON' });
  });

  it('refuses an override with no req.user at all (unauthenticated), the same as any other requirePermission gate', async () => {
    const res = createResponse();
    const req = makeOverrideReq({ port: 9999 }, null);
    const rconService = req.app.get();

    await getConnectHandler()(req, res);

    expect(res.statusCode).toBe(401);
    expect(rconService.updateConfig).not.toHaveBeenCalled();
  });
});

describe('RCON route malformed request handling', () => {
  it('returns 400 for a missing test body', async () => {
    const res = createResponse();

    await getTestHandler()({ body: null }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.detail).toBe('Invalid host format');
  });

  it('returns 400 for a non-string execute command without throwing', async () => {
    const res = createResponse();

    await getHandler('/execute')(
      { body: { command: 123 }, app: { get: vi.fn() } },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('RCON_COMMAND_INVALID');
  });
});

// 2026-08-27 bug hunt: POST /execute broadcasts its command AND response to
// a socket room via rcon:response, and separately logs the command via
// log.info -- both were the raw, unredacted string. logCommand()
// (database/init.js) already redacts an adduser password before persisting
// to command_history for exactly this reason (see rconCommandRedaction.js);
// these two sites were never brought in line, so `adduser "Bob" "hunter2"`
// still reached every subscribed socket, and every log line, in cleartext.
// Wire-level coverage: calls the real handler and asserts on what actually
// got emitted/logged, not on source text.
//
// 2026-08-31 bug hunt: the broadcast target moved from "logs" (gated
// diagnostics.manage in index.js) to "rcon-live" (gated rcon.execute) --
// the same content class GET /api/rcon/history has always gated rcon.execute
// alone, per this file's own header comment above. diagnostics.manage is a
// different, broader capability a custom "diagnostics-only observer" role
// could plausibly hold without rcon.execute, per that capability's own
// catalogue description (never mentions RCON). Tests below assert the room
// name explicitly, and one proves "logs" no longer receives it at all --
// a retarget bug is invisible to a test that only checks the event fired
// somewhere.
describe('RCON /execute -- redacts secrets before they leave the route', () => {
  function createIoMock() {
    const emitted = [];
    return {
      emitted,
      to: (room) => ({
        emit: (event, payload) => emitted.push({ room, event, payload }),
      }),
    };
  }

  it('redacts the adduser password in the rcon:response broadcast, both command and response fields', async () => {
    const res = createResponse();
    const io = createIoMock();
    const rconService = {
      execute: vi.fn(async () => ({
        success: true,
        response: 'Command received: adduser "Bob" "hunter2" -> User added',
      })),
    };

    await getHandler('/execute')(
      {
        body: { command: 'adduser "Bob" "hunter2"' },
        app: { get: (key) => (key === 'rconService' ? rconService : io) },
      },
      res,
    );

    expect(res.statusCode).toBe(undefined); // res.json(), no explicit status -- 200 default
    const broadcast = io.emitted.find((e) => e.event === 'rcon:response');
    expect(broadcast.payload.command).toBe('adduser "Bob" "[REDACTED]"');
    expect(broadcast.payload.response).toBe(
      'Command received: adduser "Bob" "[REDACTED]" -> User added',
    );
  });

  it('does not alter a command with no password to redact', async () => {
    const res = createResponse();
    const io = createIoMock();
    const rconService = {
      execute: vi.fn(async () => ({ success: true, response: 'players: Bob' })),
    };

    await getHandler('/execute')(
      {
        body: { command: 'players' },
        app: { get: (key) => (key === 'rconService' ? rconService : io) },
      },
      res,
    );

    const broadcast = io.emitted.find((e) => e.event === 'rcon:response');
    expect(broadcast.payload.command).toBe('players');
    expect(broadcast.payload.response).toBe('players: Bob');
  });

  it('broadcasts rcon:response into the "rcon-live" room, not "logs" -- rcon.execute is the gate, not the broader diagnostics.manage', async () => {
    const res = createResponse();
    const io = createIoMock();
    const rconService = {
      execute: vi.fn(async () => ({ success: true, response: 'players: Bob' })),
    };

    await getHandler('/execute')(
      {
        body: { command: 'players' },
        app: { get: (key) => (key === 'rconService' ? rconService : io) },
      },
      res,
    );

    const broadcast = io.emitted.find((e) => e.event === 'rcon:response');
    expect(broadcast.room).toBe('rcon-live');
    // The control that makes the above meaningful: a fix that broadcast to
    // BOTH rooms would still pass a test that only checks "rcon-live" was
    // used somewhere -- confirm "logs" gets nothing at all from this route.
    expect(io.emitted.some((e) => e.room === 'logs')).toBe(false);
  });
});
