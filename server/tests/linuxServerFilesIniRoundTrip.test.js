import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// 2026-08-29 hunt (god): config-editing surface, suspect 1 -- "the same
// question that found suspect 6." Reads a realistic server.ini through the
// REAL GET /ini route, resubmits the exact settings object unchanged
// through the REAL PUT /ini route (the same round trip the client actually
// performs -- ServerConfig.tsx spreads GET's full settings object into
// iniSettings state via `{...parsed}` and resends the whole thing on every
// save, confirmed by reading mergeSchemaDefaults()), and diffs the file
// byte-for-byte against the original.
//
// Also covers suspect 2 (what happens to lines the panel doesn't model):
// comments, blank lines, and a key with no entry in the panel's own
// INI_SCHEMA are all present in the fixture.

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/serverFiles.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

// 2026-09-08 quadruple-read sweep: every handler now reads
// req.activeServerContext instead of re-deriving it, populated once by the
// router's own gate (a non-route layer getRouteHandlers() above never
// reaches). Run it first, on the same req.
function getGateMiddleware() {
  return router.stack.filter((entry) => !entry.route)[1].handle;
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  await getGateMiddleware()(req, res, () => {});
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const SERVER_NAME = "RoundTripTest";
let configDir;
let iniPath;

// A realistic slice of a real PZ servertest.ini: comments, blank lines,
// booleans, numbers, an empty-string value, and one key the panel's own
// INI_SCHEMA has no entry for (RCONPort IS in the real schema, so use a
// deliberately obscure/newer key PZ ships that this panel version predates).
const FIXTURE = [
  "# ZomboidINI",
  "version=1",
  "",
  "PVP=true",
  "PublicName=My Test Server",
  "PublicDescription=",
  "MaxPlayers=32",
  "DefaultPort=16261",
  "; comment about UDP",
  "UDPPort=16262",
  "SomeFutureEngineKeyThisPanelHasNoUiFor=42",
  "",
].join("\n");

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ini-roundtrip-"));
  iniPath = path.join(configDir, `${SERVER_NAME}.ini`);
  fs.writeFileSync(iniPath, FIXTURE);
  getActiveServer.mockReset().mockResolvedValue({
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("GET /ini -> PUT /ini round trip with no changes", () => {
  it("preserves every key's value, including one the panel's schema has no UI for", async () => {
    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    expect(getRes.getStatusCode()).toBe(200);
    const { settings } = getRes.getBody();

    const putRes = await runRoute("/ini", "put", {
      user: { role: "admin" },
      body: { settings },
    });
    expect(putRes.getStatusCode()).toBe(200);

    const after = fs.readFileSync(iniPath, "utf-8");
    const afterLines = after.split(/\r?\n/).filter(Boolean);

    // Every original key must still be present with its original value --
    // the unknown-to-the-schema key above is the one that would silently
    // vanish if the client's submission were curated down to a fixed list
    // of known fields instead of round-tripping everything GET returned.
    expect(afterLines).toEqual(
      expect.arrayContaining([
        "PVP=true",
        "PublicName=My Test Server",
        "MaxPlayers=32",
        "DefaultPort=16261",
        "UDPPort=16262",
        "SomeFutureEngineKeyThisPanelHasNoUiFor=42",
      ]),
    );

    // Comments and blank lines survive too.
    expect(after).toContain("# ZomboidINI");
    expect(after).toContain("; comment about UDP");
  });

  it("changing one field does not disturb any other line's value", async () => {
    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();

    const putRes = await runRoute("/ini", "put", {
      user: { role: "admin" },
      body: { settings: { ...settings, PublicName: "Renamed Server" } },
    });
    expect(putRes.getStatusCode()).toBe(200);

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toContain("PublicName=Renamed Server");
    // Every other field, including the unknown one, is untouched.
    expect(after).toContain("PVP=true");
    expect(after).toContain("MaxPlayers=32");
    expect(after).toContain("SomeFutureEngineKeyThisPanelHasNoUiFor=42");
  });

  it("is byte-for-byte identical to the original, not just line-for-line equivalent, when nothing changed", async () => {
    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();

    await runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toBe(FIXTURE);
  });
});

describe("GET /ini -> PUT /ini round trip: line endings and encoding (suspect 3)", () => {
  // 2026-08-29: confirmed empirically that toIni() unconditionally rejoined
  // with "\n", silently converting an entire CRLF-written INI to LF-only on
  // every structured save, even an unchanged one -- while mods.js's own INI
  // writers never have this problem, since they patch one matched line via
  // regex-replace on the raw string and leave every other line's original
  // terminator untouched. Both editors write the SAME file. Fixed by
  // detecting the original file's line-ending style and preserving it.
  it("preserves CRLF line endings through an unchanged save instead of silently converting to LF", async () => {
    const crlfFixture = FIXTURE.replace(/\n/g, "\r\n");
    fs.writeFileSync(iniPath, crlfFixture);

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();
    await runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toBe(crlfFixture);
  });

  it("preserves CRLF line endings when one field actually changes", async () => {
    const crlfFixture = FIXTURE.replace(/\n/g, "\r\n");
    fs.writeFileSync(iniPath, crlfFixture);

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();
    await runRoute("/ini", "put", {
      user: { role: "admin" },
      body: { settings: { ...settings, PublicName: "Renamed Server" } },
    });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toContain("PublicName=Renamed Server\r\n");
    expect(after).not.toMatch(/[^\r]\n/); // no bare LF anywhere
  });

  it("non-ASCII values survive an unchanged save byte-for-byte (already correct, pinned as a regression check)", async () => {
    const unicodeFixture = FIXTURE.replace(
      "PublicName=My Test Server",
      "PublicName=Café Zómboid 日本サーバー",
    );
    fs.writeFileSync(iniPath, unicodeFixture, "utf-8");

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();
    await runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toBe(unicodeFixture);
  });

  it("a value containing the '=' separator character round-trips unchanged (already correct, pinned as a regression check)", async () => {
    const eqFixture = FIXTURE.replace(
      "PublicName=My Test Server",
      "PublicName=My=Test=Server",
    );
    fs.writeFileSync(iniPath, eqFixture, "utf-8");

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();
    expect(settings.PublicName).toBe("My=Test=Server");
    await runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toBe(eqFixture);
  });

  it("a missing trailing newline at EOF is not silently added", async () => {
    const noTrailingNewline = FIXTURE.replace(/\n$/, "");
    fs.writeFileSync(iniPath, noTrailingNewline, "utf-8");

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();
    await runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toBe(noTrailingNewline);
  });
});

describe("GET /ini -> PUT /ini round trip: per-line formatting the panel never asked to change (suspect 7)", () => {
  // 2026-08-29 hunt-wave13 (god): same shape as the CRLF bug (573f63fd), one
  // level down -- toIni() rebuilds every line whose key is present in the
  // submitted settings as a hardcoded "key=value" with NO surrounding
  // whitespace, even when only OTHER fields actually changed (or nothing did
  // at all). The client always resends every key GET returned, so this fires
  // on every structured save. A file hand-edited with spacing around "="
  // (extremely common -- copy-pasted from a wiki example, or just a human's
  // habit) gets that spacing silently stripped the first time anyone saves
  // any field from the structured editor.
  const spacedFixture = [
    "# ZomboidINI",
    "version=1",
    "",
    "PVP = true",
    "  MaxPlayers=32",
    "DefaultPort =16261",
    "",
  ].join("\n");

  it("preserves spacing around '=' and leading indentation on an unrelated field change", async () => {
    fs.writeFileSync(iniPath, spacedFixture, "utf-8");

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();

    await runRoute("/ini", "put", {
      user: { role: "admin" },
      body: { settings: { ...settings, PublicName: "Renamed Server" } },
    });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toContain("PVP = true");
    expect(after).toContain("  MaxPlayers=32");
    expect(after).toContain("DefaultPort =16261");
  });

  it("preserves spacing around '=' on an unchanged save", async () => {
    fs.writeFileSync(iniPath, spacedFixture, "utf-8");

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();
    await runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toBe(spacedFixture);
  });
});

describe("GET /ini -> PUT /ini round trip: byte-order mark (suspect 8)", () => {
  // 2026-08-29 hunt-wave13 (god): Windows Notepad's default "UTF-8" save
  // option prepends a BOM (U+FEFF). fs.readFileSync(path, "utf-8") does NOT
  // strip it -- it stays as a literal leading character in the decoded
  // string. String.prototype.trim() does not strip U+FEFF either (it is not
  // in ECMAScript's WhiteSpace/LineTerminator set), so if a BOM prefixes the
  // file's first key=value line, parseIni()'s `.trim()`'d key comes out as
  // "\uFEFFPVP" instead of "PVP" -- a key the panel's schema, and every other
  // reader of this settings object, will never recognize as PVP.
  const BOM = "﻿";

  it("does not mangle the first key's name with a leading BOM", async () => {
    // No leading "# ZomboidINI" comment here deliberately -- that comment
    // line has no "=" at all, so a BOM stuck to IT would be a no-op either
    // way (both parseIni and toIni ignore any line without "=" regardless of
    // whether the comment-prefix check matches). The real exposure is a BOM
    // landing directly on the file's first key=value line, which real
    // ZomboidINI files (no header comment on some PZ versions/exports) can
    // have.
    const bomFixture = BOM + "version=1\nPVP=true\n";
    fs.writeFileSync(iniPath, bomFixture, "utf-8");

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();

    expect(settings.version).toBe("1");
    expect(Object.keys(settings).some((k) => k.includes("﻿"))).toBe(false);
  });
});
