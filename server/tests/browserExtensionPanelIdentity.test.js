import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { loadSteamSyncPopup } from "./helpers/steamSyncPopup.js";

// Security audit R2-31 (2026-10-28): a plain-http:// panel address on the
// user's own network (192.168.1.20, garage.lan) says nothing about who
// answers there once the laptop is on another network. One click on Send
// gave whoever did the Steam cookies (sessionid + steamLoginSecure: the
// Steam account), and after a 401 the remembered panel password too. The
// popup now keeps the key the panel hands out at sign-in and, before
// anything goes to such an address again, has it answer a fresh challenge
// with that key (server side: extensionPanelProof.test.js).

const LAN_PANEL = "http://192.168.1.20:3001";
const PANEL_KEY = "the-real-panels-key-for-admin";

const proofFor = (key, challenge) =>
  crypto.createHmac("sha256", key).update(`zcp-steam-sync-proof-v1:${challenge}`).digest("base64url");

// The panel itself.
function realPanel(request) {
  if (request.path === "/api/auth/login") {
    return { body: { accessToken: "real-token", panelKey: PANEL_KEY } };
  }
  if (request.path === "/api/auth/extension-proof") {
    return { body: { proof: proofFor(PANEL_KEY, request.body.challenge) } };
  }
  return { body: { ok: true } };
}

// Whatever answers at the same address on another network: takes anything,
// says the session expired to get the password, and can't know the key.
function impostor({ proof } = {}) {
  return (request) => {
    if (request.path === "/api/auth/extension-proof") {
      return proof ? proof(request) : { status: 404, body: { error: "Not found" } };
    }
    if (request.path === "/api/auth/login") return { body: { accessToken: "fake", panelKey: "impostor-key" } };
    return { status: 401, body: { error: "Session expired" } };
  };
}

// Set up on the real panel with "Remember password", as most users do.
async function setUpOnRealPanel(panelUrl = LAN_PANEL) {
  let answer = realPanel;
  const popup = loadSteamSyncPopup({ respond: (request) => answer(request) });
  popup.fill({ panelUrl, username: "admin", password: "panel-password", rememberPassword: true });
  await popup.test();
  expect(popup.setupStatus()).toMatch(/Login OK/);
  popup.requests.length = 0;
  return {
    popup,
    moveTo(responder) {
      answer = responder;
    },
  };
}

const secretsIn = (requests) =>
  requests.filter(
    (request) =>
      request.headers.Authorization ||
      request.body?.password ||
      request.body?.sessionid ||
      request.body?.steamLoginSecure,
  );

describe("Steam Sync popup: a plain-http:// panel must prove it is the panel (R2-31)", () => {
  it("sends neither the Steam cookies nor the password to another host answering at the panel's address", async () => {
    const { popup, moveTo } = await setUpOnRealPanel();
    moveTo(impostor());

    await popup.send();

    expect(secretsIn(popup.requests)).toEqual([]);
    expect(popup.requests.map((request) => request.path)).toEqual(["/api/auth/extension-proof"]);
    expect(Object.keys(popup.requests[0].body).sort()).toEqual(["challenge", "username"]);
    expect(popup.sendStatus()).toMatch(/Nothing was sent/);
  });

  it("refuses a wrong answer as firmly as none", async () => {
    const { popup, moveTo } = await setUpOnRealPanel();
    moveTo(impostor({ proof: () => ({ body: { proof: proofFor("guessed-key", "anything") } }) }));

    await popup.send();

    expect(secretsIn(popup.requests)).toEqual([]);
    expect(popup.sendStatus()).toMatch(/did not prove it is the panel you signed in to/);
  });

  it("goes ahead on the real panel", async () => {
    const { popup } = await setUpOnRealPanel();

    await popup.send();

    expect(popup.requests.map((request) => request.path)).toEqual([
      "/api/auth/extension-proof",
      "/api/mods/collection/extension-push",
    ]);
    expect(popup.sendStatus()).toMatch(/Cookies sent/);
  });

  it("keeps the key from the first sign-in and asks the panel for it", async () => {
    const popup = loadSteamSyncPopup({ respond: realPanel });
    popup.fill({ panelUrl: LAN_PANEL, username: "admin", password: "panel-password" });
    await popup.test();

    expect(popup.requests[0].body.wantsPanelKey).toBe(true);
    expect(Object.values(popup.storage.panelKeys).map((entry) => entry.key)).toEqual([PANEL_KEY]);
  });

  it("counts only this computer's own addresses as this computer", () => {
    const { context } = loadSteamSyncPopup();
    for (const host of ["localhost", "panel.localhost", "127.0.0.1", "127.8.9.10", "[::1]", "[::ffff:127.0.0.1]"]) {
      expect(context.isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ["192.168.1.20", "10.0.0.1", "garage.lan", "localhost.evil.com", "127.0.0.1.nip.io", "[fe80::1]", "[::ffff:192.168.1.20]"]) {
      expect(context.isLoopbackHost(host), host).toBe(false);
    }
  });

  it("needs no check over https:// or on this computer", async () => {
    for (const panelUrl of ["https://panel.example.com", "http://localhost:3001", "http://127.0.0.1:3001"]) {
      const { popup } = await setUpOnRealPanel(panelUrl);
      await popup.send();
      expect(popup.requests.map((request) => request.path), panelUrl).toEqual(["/api/mods/collection/extension-push"]);
    }
  });

  it("works as before with a panel too old to hand out a key", async () => {
    const popup = loadSteamSyncPopup({
      respond: (request) => (request.path === "/api/auth/login" ? { body: { accessToken: "old-panel-token" } } : { body: { ok: true } }),
    });
    popup.fill({ panelUrl: LAN_PANEL, username: "admin", password: "panel-password" });
    await popup.test();
    popup.requests.length = 0;

    await popup.send();

    expect(popup.requests.map((request) => request.path)).toEqual(["/api/mods/collection/extension-push"]);
  });

  it("lets Test login sign in again, on a second click, to a panel whose key changed; Send never does", async () => {
    const { popup, moveTo } = await setUpOnRealPanel();
    const NEW_KEY = "the-reinstalled-panels-key";
    moveTo((request) => {
      if (request.path === "/api/auth/login") return { body: { accessToken: "new-token", panelKey: NEW_KEY } };
      if (request.path === "/api/auth/extension-proof") return { body: { proof: proofFor(NEW_KEY, request.body.challenge) } };
      return { body: { ok: true } };
    });

    await popup.send();
    await popup.send();
    expect(secretsIn(popup.requests)).toEqual([]);

    await popup.test();
    expect(popup.setupStatus()).toMatch(/click Test login again/);
    expect(secretsIn(popup.requests)).toEqual([]);

    await popup.test();
    expect(popup.setupStatus()).toMatch(/Login OK/);
    popup.requests.length = 0;

    await popup.send();
    expect(popup.sendStatus()).toMatch(/Cookies sent/);
  });

  // Adversary pass: replay an answer the real panel gave earlier.
  it("refuses an answer replayed from an earlier check", async () => {
    const { popup, moveTo } = await setUpOnRealPanel();
    await popup.send();
    const recorded = { challenge: popup.requests[0].body.challenge, proof: proofFor(PANEL_KEY, popup.requests[0].body.challenge) };
    popup.requests.length = 0;
    moveTo(impostor({ proof: () => ({ body: { proof: recorded.proof } }) }));

    await popup.send();

    expect(popup.requests[0].body.challenge).not.toBe(recorded.challenge);
    expect(secretsIn(popup.requests)).toEqual([]);
  });

  // Another account on the same panel knows its own key: it can't stand in
  // for this account's panel with it.
  it("doesn't let another account's key vouch for this one", async () => {
    const { popup, moveTo } = await setUpOnRealPanel();
    const MODERATOR_KEY = "the-real-panels-key-for-moderator";
    moveTo(impostor({ proof: (request) => ({ body: { proof: proofFor(MODERATOR_KEY, request.body.challenge) } }) }));

    await popup.send();

    expect(popup.requests[0].body.username).toBe("admin");
    expect(secretsIn(popup.requests)).toEqual([]);
  });
});
