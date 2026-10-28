import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";
import { runServerFilesRoute } from "./helpers/serverFilesRoute.js";

// Security audit R1-28: a config template saved by v1.2.6 or older kept the
// RCON and join passwords (POST /templates strips them only since v1.2.7),
// and GET /templates/:id returned them as stored, while GET /ini and GET
// /raw mask the same keys for the same role. PUT rewrote the old file
// as it was. Every read now strips them, and PUT cleans the stored file.
//
// CodeQL js/file-system-race (alerts 244/245): the templates folder is the
// game's own Zomboid/Server/templates, which another container or account
// can share. PUT read the file, parsed it and wrote it back with
// fs.writeFileSync, which follows whatever the name points at by then.

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/serverFiles.js");

function createResponse() {
  let statusCode = 200;
  let body = null;
  const response = {
    status(code) {
      statusCode = code;
      return response;
    },
    json(payload) {
      body = payload;
      return response;
    },
    getStatusCode: () => statusCode,
    getBody: () => body,
  };
  return response;
}

function runRoute(routePath, method, req) {
  return runServerFilesRoute(router, routePath, method, req, createResponse());
}

const SERVER_NAME = "LegacySrv";
const RCON_PASSWORD = "legacy-rcon-s3cret";
const JOIN_PASSWORD = "legacy-join-s3cret";
const admin = { role: "admin" };
let rootDir;
let outsideDir;
let configDir;
let templatesDir;

function legacyTemplate() {
  // The shape POST /templates wrote before v1.2.7.
  return {
    name: "Old one",
    description: "",
    type: "ini",
    created: "2026-05-01T10:00:00.000Z",
    serverName: SERVER_NAME,
    ini: { PVP: "true", RCONPassword: RCON_PASSWORD, Password: JOIN_PASSWORD, DefaultPort: "16261" },
    iniRaw: `PVP=true\nRCONPassword=${RCON_PASSWORD}\nPassword=${JOIN_PASSWORD}\nDefaultPort=16261\n`,
  };
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-legacy-"));
  // Same volume (hard links), outside the data folder.
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-legacy-outside-"));
  configDir = path.join(rootDir, "Server");
  templatesDir = path.join(configDir, "templates");
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, `${SERVER_NAME}.ini`), "PVP=false\n");
  fs.writeFileSync(path.join(templatesDir, "old_one.json"), JSON.stringify(legacyTemplate(), null, 2));
  getActiveServer.mockReset().mockResolvedValue({
    zomboidDataPath: rootDir,
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe("a template saved before v1.2.7 never hands back its passwords", () => {
  it("GET /templates/:id strips RCONPassword and Password from both copies", async () => {
    const res = await runRoute("/templates/:id", "get", { user: admin, params: { id: "old_one" } });
    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    const text = JSON.stringify(body);
    expect(text).not.toContain(RCON_PASSWORD);
    expect(text).not.toContain(JOIN_PASSWORD);
    expect(body.ini).toEqual({ PVP: "true", DefaultPort: "16261" });
    expect(body.iniRaw).toBe("PVP=true\nDefaultPort=16261\n");
    expect(body.name).toBe("Old one");
  });

  it("PUT /templates/:id cleans the stored file and keeps the rest", async () => {
    const res = await runRoute("/templates/:id", "put", {
      user: admin,
      params: { id: "old_one" },
      body: { description: "renamed" },
    });
    expect(res.getStatusCode()).toBe(200);
    const stored = fs.readFileSync(path.join(templatesDir, "old_one.json"), "utf-8");
    expect(stored).not.toContain(RCON_PASSWORD);
    expect(stored).not.toContain(JOIN_PASSWORD);
    const parsed = JSON.parse(stored);
    expect(parsed.description).toBe("renamed");
    expect(parsed.ini).toEqual({ PVP: "true", DefaultPort: "16261" });
    expect(parsed.iniRaw).toContain("PVP=true");
  });

  it("a secret key spelled in another case is stripped too", async () => {
    const tpl = legacyTemplate();
    tpl.ini = { rconpassword: RCON_PASSWORD, PVP: "true" };
    tpl.iniRaw = `rconpassword = ${RCON_PASSWORD}\nPVP=true\n`;
    fs.writeFileSync(path.join(templatesDir, "old_one.json"), JSON.stringify(tpl));
    const res = await runRoute("/templates/:id", "get", { user: admin, params: { id: "old_one" } });
    expect(JSON.stringify(res.getBody())).not.toContain(RCON_PASSWORD);
  });

  it("apply still writes the live passwords, not the stale ones", async () => {
    fs.writeFileSync(
      path.join(configDir, `${SERVER_NAME}.ini`),
      "PVP=false\nRCONPassword=live-rcon\nPassword=live-join\n",
    );
    const res = await runRoute("/templates/:id/apply", "post", {
      user: admin,
      params: { id: "old_one" },
      body: { applySandbox: false },
    });
    expect(res.getStatusCode()).toBe(200);
    const live = fs.readFileSync(path.join(configDir, `${SERVER_NAME}.ini`), "utf-8");
    expect(live).toContain("RCONPassword=live-rcon");
    expect(live).toContain("Password=live-join");
    expect(live).not.toContain(RCON_PASSWORD);
    expect(live).toContain("PVP=true");
  });
});

describe("template writes never go through a name that points at another file", () => {
  it("PUT replaces a template that is a hard link to another file instead of writing into that file", async () => {
    const outside = path.join(outsideDir, "panel-db.json");
    fs.writeFileSync(outside, JSON.stringify({ name: "outside", keep: true }));
    const linked = path.join(templatesDir, "linked.json");
    fs.linkSync(outside, linked);

    const res = await runRoute("/templates/:id", "put", {
      user: admin,
      params: { id: "linked" },
      body: { name: "changed" },
    });
    expect(res.getStatusCode()).toBe(200);
    expect(JSON.parse(fs.readFileSync(outside, "utf-8"))).toEqual({ name: "outside", keep: true });
    expect(JSON.parse(fs.readFileSync(linked, "utf-8")).name).toBe("changed");
  });

  it("POST never writes through a name that turns up between its check and its write", async () => {
    const outside = path.join(outsideDir, "victim.json");
    fs.writeFileSync(outside, "untouched");
    const target = path.join(templatesDir, "fresh.json");
    // The name is free when POST checks it, and taken (here a hard link to
    // another file) by the time it writes.
    const realExists = fs.existsSync;
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const result = realExists(p);
      if (p === target && !result) fs.linkSync(outside, target);
      return result;
    });
    try {
      const res = await runRoute("/templates", "post", {
        user: admin,
        body: { name: "Fresh", includeIni: true, includeSandbox: false },
      });
      expect(res.getStatusCode()).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(outside, "utf-8")).toBe("untouched");
  });

  it.skipIf(process.platform === "win32")("GET, PUT and the listing refuse a template that is a symlink", async () => {
    const outside = path.join(outsideDir, "secret.json");
    fs.writeFileSync(outside, JSON.stringify({ name: "outside", token: "do-not-read" }));
    fs.symlinkSync(outside, path.join(templatesDir, "sneaky.json"));

    const get = await runRoute("/templates/:id", "get", { user: admin, params: { id: "sneaky" } });
    expect(get.getStatusCode()).toBe(404);

    const put = await runRoute("/templates/:id", "put", {
      user: admin,
      params: { id: "sneaky" },
      body: { name: "x" },
    });
    expect(put.getStatusCode()).toBe(404);
    expect(JSON.parse(fs.readFileSync(outside, "utf-8")).name).toBe("outside");

    const list = await runRoute("/templates", "get", { user: admin });
    expect(list.getBody().templates.map((t) => t.id)).toEqual(["old_one"]);
  });
});
