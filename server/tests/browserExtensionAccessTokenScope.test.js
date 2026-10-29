import { describe, expect, it } from "vitest";
import { loadSteamSyncPopup } from "./helpers/steamSyncPopup.js";

// Security audit R2-30 (2026-10-28): the Steam Sync popup kept one access
// token for whatever panel URL and username were saved next. Saving another
// panel's address and pressing Send handed panel A's token (an admin JWT,
// good for 15 minutes against panel A) to panel B. The token is now kept
// with the panel and username it came from and only ever sent back there.

const PANEL_A = "http://192.168.1.20:3001";
const PANEL_B = "https://vps.example:3001";

// Each panel signs its user in with its own token and takes the cookies.
function panels(request) {
  if (request.path === "/api/auth/login") {
    return { body: { accessToken: `token-for-${request.origin}-${request.body.username}` } };
  }
  return { body: { ok: true } };
}

const bearer = (request) => request.headers.Authorization;

async function signedInToPanelA({ rememberPassword = false } = {}) {
  const popup = loadSteamSyncPopup({ respond: panels });
  popup.fill({ panelUrl: PANEL_A, username: "admin", password: "panel-a-password", rememberPassword });
  await popup.test();
  expect(popup.setupStatus()).toMatch(/Login OK/);
  return popup;
}

describe("Steam Sync popup: the cached access token stays with its panel and username (R2-30)", () => {
  it("never sends panel A's token to panel B after the URL is changed and saved", async () => {
    const popup = await signedInToPanelA();
    popup.fill({ panelUrl: PANEL_B, password: "" });
    await popup.save();
    popup.requests.length = 0;

    await popup.send();

    expect(popup.requests.filter((request) => request.origin === new URL(PANEL_B).origin)).toEqual([]);
    expect(popup.sendStatus()).toMatch(/Password is required/);
  });

  it("signs in to panel B first when a password is at hand, and pushes with B's own token", async () => {
    const popup = await signedInToPanelA({ rememberPassword: true });
    popup.fill({ panelUrl: PANEL_B, password: "panel-b-password" });
    await popup.save();
    popup.requests.length = 0;

    await popup.send();

    expect(popup.requests.map((request) => request.path)).toEqual([
      "/api/auth/login",
      "/api/mods/collection/extension-push",
    ]);
    expect(popup.requests.every((request) => request.origin === new URL(PANEL_B).origin)).toBe(true);
    expect(bearer(popup.requests[1])).toBe(`Bearer token-for-${new URL(PANEL_B).origin}-admin`);
  });

  it("does not send one account's token as another on the same panel", async () => {
    const popup = await signedInToPanelA();
    popup.fill({ username: "moderator", password: "" });
    await popup.save();
    popup.requests.length = 0;

    await popup.send();

    expect(popup.requests.map(bearer).filter(Boolean)).toEqual([]);
  });

  it("ignores a token saved by an older version, which names no panel", async () => {
    const popup = loadSteamSyncPopup({ respond: panels });
    Object.assign(popup.storage, { panelUrl: PANEL_B, username: "admin", accessToken: "token-from-panel-a" });

    await popup.send();

    expect(popup.requests.map(bearer).filter(Boolean)).toEqual([]);
  });

  it("still reuses the token on the panel and account it came from", async () => {
    const popup = await signedInToPanelA();
    popup.fill({ password: "" });
    popup.requests.length = 0;

    await popup.send();

    expect(popup.requests.map((request) => request.path)).toEqual(["/api/mods/collection/extension-push"]);
    expect(bearer(popup.requests[0])).toBe(`Bearer token-for-${new URL(PANEL_A).origin}-admin`);
    expect(popup.sendStatus()).toMatch(/Cookies sent/);
  });

  // Adversary pass: the same panel written another way, or the URL changed
  // in the field without Save.
  it("treats the same panel and account written differently as the same, and anything else as another panel", async () => {
    const popup = await signedInToPanelA();
    popup.fill({ panelUrl: `${PANEL_A}/`, username: " Admin ", password: "" });
    await popup.save();
    popup.requests.length = 0;
    await popup.send();
    expect(bearer(popup.requests[0])).toBe(`Bearer token-for-${new URL(PANEL_A).origin}-admin`);

    popup.fill({ panelUrl: `${PANEL_A}/other` });
    await popup.save();
    popup.requests.length = 0;
    await popup.send();
    expect(popup.requests.map(bearer).filter(Boolean)).toEqual([]);
  });

  it("sends nothing to an unsaved address typed in the field: Send uses the saved panel", async () => {
    const popup = await signedInToPanelA();
    popup.fill({ panelUrl: PANEL_B, password: "" });
    popup.requests.length = 0;

    await popup.send();

    expect(popup.requests.every((request) => request.origin === new URL(PANEL_A).origin)).toBe(true);
  });
});
