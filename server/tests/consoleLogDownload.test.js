import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// Caldac: the Console page's log tab gets a "Download server-console.txt"
// button, so sharing the game's console log no longer means building the
// whole support bundle. GET /api/server/console-log/download streams the
// file the tab tails -- same permission, same folder rule, the same per-role
// view as GET /console-log, and the support bundle's secret redaction.

const init = await import("../database/init.js");
const { default: serverRouter } = await import("../routes/server.js");

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-console-download-"));
const DATA_DIR = path.join(TEMP_ROOT, "Zomboid");
const LOG = path.join(DATA_DIR, "server-console.txt");
const HOST_PATH = path.join(TEMP_ROOT, "Steam", "steamapps", "workshop", "content", "108600", "2392709985");

const CONTENT = [
  "LOG  : General      > SERVER STARTED",
  "LOG  : General      > Command line admin password: Sup3rS3cret!",
  'LOG  : General      > RCON: command adduser "bob" "BobPa55word"',
  "LOG  : General      > rcon password is KnownRcon9876 here",
  `LOG  : Mod          > loading ${HOST_PATH}`,
  "LOG  : General      > 本地化 ok",
  "",
].join("\n");

let baseUrl;
let httpServer;
let currentRole = "admin";

beforeAll(async () => {
  await init.initDatabase();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const server = await init.createServer({
    name: "Caldac Main/../x",
    serverName: "servertest",
    zomboidDataPath: DATA_DIR,
    rconPassword: "KnownRcon9876",
  });
  await init.setActiveServer(server.id);

  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("io", null);
  app.use("/api/server", serverRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  currentRole = "admin";
  fs.writeFileSync(LOG, CONTENT);
});

describe("GET /api/server/console-log/download", () => {
  it("sends the console log as an attachment with a safe dated file name", async () => {
    const res = await fetch(`${baseUrl}/api/server/console-log/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    const disposition = res.headers.get("content-disposition");
    expect(disposition).toMatch(/^attachment; filename="server-console-Caldac_Main_.._x-\d{4}-\d{2}-\d{2}\.txt"$/);
    expect(disposition).not.toContain("/");
    const body = await res.text();
    expect(body).toContain("SERVER STARTED");
    expect(body).toContain("本地化 ok");
    // An admin sees the folders, as on the Console page.
    expect(body).toContain(HOST_PATH);
  });

  for (const role of ["moderator", "technician", "admin"]) {
    it(`redacts the secrets the support bundle redacts for ${role}`, async () => {
      currentRole = role;
      const body = await (await fetch(`${baseUrl}/api/server/console-log/download`)).text();
      expect(body).not.toContain("Sup3rS3cret!");
      expect(body).not.toContain("BobPa55word");
      expect(body).not.toContain("KnownRcon9876");
      expect(body).toContain("Command line admin password: [REDACTED]");
    });
  }

  it("hides host folders from a role that doesn't see them", async () => {
    currentRole = "moderator";
    const body = await (await fetch(`${baseUrl}/api/server/console-log/download`)).text();
    expect(body).not.toContain(HOST_PATH);
    expect(body).toContain("SERVER STARTED");
  });

  it("is refused without the console log capability", async () => {
    currentRole = "viewer";
    const res = await fetch(`${baseUrl}/api/server/console-log/download`);
    expect(res.status).toBe(403);
  });

  it("answers FILE_NOT_FOUND when the game has not written the log yet", async () => {
    fs.rmSync(LOG, { force: true });
    const res = await fetch(`${baseUrl}/api/server/console-log/download`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("reads only the active server's known console path, never one from the request", async () => {
    const elsewhere = path.join(TEMP_ROOT, "elsewhere.txt");
    fs.writeFileSync(elsewhere, "NOT THE CONSOLE LOG\n");
    const res = await fetch(
      `${baseUrl}/api/server/console-log/download?path=${encodeURIComponent(elsewhere)}&file=../elsewhere.txt`,
    );
    const body = await res.text();
    expect(body).toContain("SERVER STARTED");
    expect(body).not.toContain("NOT THE CONSOLE LOG");
  });
});
