import { describe, expect, it } from "vitest";
import {
  normalizeChromiumCookieRow,
  normalizeFirefoxCookieRow,
  pickSteamCookies,
} from "../utils/browserCookies.js";

const CHROMIUM_EPOCH_OFFSET_US = 11644473600000000n;

function chromiumTimestamp(unixMs) {
  return (BigInt(unixMs) * 1000n + CHROMIUM_EPOCH_OFFSET_US).toString();
}

function cookie(overrides) {
  return {
    name: "sessionid",
    value: "cookie-value",
    host: ".steamcommunity.com",
    profileId: "Default",
    expiresAt: null,
    createdAt: 100,
    lastAccessedAt: 100,
    ...overrides,
  };
}

describe("browser cookie timestamp normalization", () => {
  it("converts Chromium's 1601-based microsecond timestamps", () => {
    const row = normalizeChromiumCookieRow(
      {
        host_key: ".steamcommunity.com",
        name: "sessionid",
        value: "value",
        expires_utc: chromiumTimestamp(Date.UTC(2030, 0, 2, 3, 4, 5)),
        creation_utc: chromiumTimestamp(Date.UTC(2026, 1, 3, 4, 5, 6)),
        last_access_utc: chromiumTimestamp(Date.UTC(2026, 2, 4, 5, 6, 7)),
        is_persistent: 1,
      },
      "Chrome/Default",
    );

    expect(new Date(row.expiresAt).toISOString()).toBe("2030-01-02T03:04:05.000Z");
    expect(new Date(row.createdAt).toISOString()).toBe("2026-02-03T04:05:06.000Z");
    expect(new Date(row.lastAccessedAt).toISOString()).toBe("2026-03-04T05:06:07.000Z");
    expect(row.profileId).toBe("Chrome/Default");
  });

  it("converts Firefox expiry seconds and creation/access microseconds", () => {
    const row = normalizeFirefoxCookieRow(
      {
        host: ".steamcommunity.com",
        name: "steamLoginSecure",
        value: "value",
        expiry: Math.floor(Date.UTC(2031, 4, 6, 7, 8, 9) / 1000),
        creationTime: String(Date.UTC(2026, 5, 7, 8, 9, 10) * 1000),
        lastAccessed: String(Date.UTC(2026, 6, 8, 9, 10, 11) * 1000),
      },
      "Firefox/default-release",
    );

    expect(new Date(row.expiresAt).toISOString()).toBe("2031-05-06T07:08:09.000Z");
    expect(new Date(row.createdAt).toISOString()).toBe("2026-06-07T08:09:10.000Z");
    expect(new Date(row.lastAccessedAt).toISOString()).toBe("2026-07-08T09:10:11.000Z");
  });
});

describe("Steam cookie freshness and pairing", () => {
  const now = 1_000_000;

  it("excludes expired persistent duplicates", () => {
    const result = pickSteamCookies(
      "chrome",
      [
        cookie({ value: "expired-session", expiresAt: now - 1, lastAccessedAt: 900 }),
        cookie({ value: "valid-session", expiresAt: now + 10_000, lastAccessedAt: 800 }),
        cookie({ name: "steamLoginSecure", value: "valid-login", expiresAt: now + 10_000 }),
      ],
      [],
      now,
    );

    expect(result.sessionid).toBe("valid-session");
    expect(result.steamLoginSecure).toBe("valid-login");
  });

  it("retains valid session cookies with no persistent expiry", () => {
    const result = pickSteamCookies(
      "firefox",
      [
        cookie({ value: "session-cookie", expiresAt: null }),
        cookie({ name: "steamLoginSecure", value: "login-cookie", expiresAt: null }),
      ],
      [],
      now,
    );

    expect(result.ok).toBe(true);
  });

  it("prefers Steam Community over a newer Steam Store pair", () => {
    const result = pickSteamCookies(
      "chrome",
      [
        cookie({ value: "community-session", lastAccessedAt: 100 }),
        cookie({ name: "steamLoginSecure", value: "community-login", lastAccessedAt: 100 }),
        cookie({ host: ".steampowered.com", value: "store-session", lastAccessedAt: 900 }),
        cookie({ host: ".steampowered.com", name: "steamLoginSecure", value: "store-login", lastAccessedAt: 900 }),
      ],
      [],
      now,
    );

    expect(result.sessionid).toBe("community-session");
    expect(result.steamLoginSecure).toBe("community-login");
  });

  it("uses timestamps rather than cookie length within a domain context", () => {
    const result = pickSteamCookies(
      "chrome",
      [
        cookie({ value: "very-long-but-stale-session-value", lastAccessedAt: 100 }),
        cookie({ value: "new", lastAccessedAt: 900 }),
        cookie({ name: "steamLoginSecure", value: "login", lastAccessedAt: 900 }),
      ],
      [],
      now,
    );

    expect(result.sessionid).toBe("new");
  });

  it("prefers a same-domain pair over a cross-domain Community fallback", () => {
    const result = pickSteamCookies(
      "chrome",
      [
        cookie({ value: "community-session", lastAccessedAt: 900 }),
        cookie({ host: ".steampowered.com", value: "store-session", lastAccessedAt: 500 }),
        cookie({ host: ".steampowered.com", name: "steamLoginSecure", value: "store-login", lastAccessedAt: 500 }),
      ],
      [],
      now,
    );

    expect(result.sessionid).toBe("store-session");
    expect(result.steamLoginSecure).toBe("store-login");
    expect(result.notes.join(" ")).not.toMatch(/cross-domain/i);
  });

  it("prefers cookies from the same browser profile", () => {
    const result = pickSteamCookies(
      "chrome",
      [
        cookie({ profileId: "Profile 1", value: "profile-one-session", lastAccessedAt: 700 }),
        cookie({ profileId: "Profile 2", value: "profile-two-session", lastAccessedAt: 900 }),
        cookie({ profileId: "Profile 1", name: "steamLoginSecure", value: "profile-one-login", lastAccessedAt: 700 }),
      ],
      [],
      now,
    );

    expect(result.sessionid).toBe("profile-one-session");
    expect(result.steamLoginSecure).toBe("profile-one-login");
  });

  it("warns about conflicting values without exposing them", () => {
    const result = pickSteamCookies(
      "firefox",
      [
        cookie({ value: "secret-old", lastAccessedAt: 100 }),
        cookie({ value: "secret-new", lastAccessedAt: 900 }),
        cookie({ name: "steamLoginSecure", value: "login-secret", lastAccessedAt: 900 }),
      ],
      [],
      now,
    );
    const warning = result.notes.join(" ");

    expect(warning).toMatch(/conflicting valid sessionid cookies/i);
    expect(warning).not.toContain("secret-old");
    expect(warning).not.toContain("secret-new");
  });

  it("warns when only a cross-domain fallback pair is available", () => {
    const result = pickSteamCookies(
      "firefox",
      [
        cookie({ value: "community-session" }),
        cookie({ host: ".steampowered.com", name: "steamLoginSecure", value: "store-login" }),
      ],
      [],
      now,
    );

    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toMatch(/cross-domain/i);
  });
});
