import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Supply-chain review 2026-10-20: the Steam Sync extension put http:// in
// front of any panel address typed without a scheme and sent the panel
// password and the Steam session cookies (steamLoginSecure: the user's Steam
// account) to it, so a panel on a VPS got them in clear text across the
// internet. Plain http:// is now used only for a host on the user's own
// network, or for one origin the user explicitly allowed; anything else
// needs https://.

const here = path.dirname(fileURLToPath(import.meta.url));
const URL_POLICY = path.resolve(here, "../../browser-extension/urlPolicy.js");
const POPUP = path.resolve(here, "../../browser-extension/popup.js");

function loadPolicy() {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(URL_POLICY, "utf8"), context, { filename: URL_POLICY });
  return context;
}

const policy = loadPolicy();
const hostOf = (url) => new URL(url).hostname;

describe("Steam Sync extension: hosts on the user's own network", () => {
  it.each([
    "http://localhost:3001",
    "http://panel.localhost:3001",
    "http://127.0.0.1:3001",
    "http://127.8.9.10",
    "http://10.1.2.3:3001",
    "http://172.16.0.1",
    "http://172.31.255.255",
    "http://192.168.1.20:3001",
    "http://169.254.10.20",
    "http://[::1]:3001",
    "http://[fd12:3456::1]",
    "http://[fc00::1]",
    "http://[fe80::1]",
    "http://[febf::1]",
    "http://[::ffff:192.168.1.20]",
    "http://nas.local:3001",
    "http://nas.local.:3001",
    "http://pz.lan",
    "http://pz.home.arpa",
    "http://pz.internal",
    // Other spellings of a private address, normalised by the URL parser.
    "http://0300.0250.1.20",
    "http://3232235796",
  ])("%s is local", (url) => {
    expect(policy.isLocalNetworkHost(hostOf(url))).toBe(true);
  });

  it.each([
    "http://8.8.8.8",
    "http://172.15.255.255",
    "http://172.32.0.1",
    "http://192.169.1.1",
    "http://11.0.0.1",
    "http://100.64.0.1",
    "http://panel.example.com",
    "http://garage:3001",
    "http://[2001:db8::1]",
    "http://[fec0::1]",
    "http://[::ffff:8.8.8.8]",
    "http://[::2]",
    // Look-alikes: the public name decides.
    "http://localhost.attacker.example",
    "http://192.168.1.20.nip.io",
    "http://nas.local.attacker.example",
    "http://lan",
    "http://local",
  ])("%s is not local", (url) => {
    expect(policy.isLocalNetworkHost(hostOf(url))).toBe(false);
  });
});

describe("Steam Sync extension: panel URL policy", () => {
  it("adds http:// only for a local host typed without a scheme, https:// for anything else", () => {
    expect(policy.normalisePanelUrl("192.168.1.20:3001")).toBe("http://192.168.1.20:3001");
    expect(policy.normalisePanelUrl("localhost:3001/")).toBe("http://localhost:3001");
    expect(policy.normalisePanelUrl("nas.local")).toBe("http://nas.local");
    expect(policy.normalisePanelUrl("panel.example.com")).toBe("https://panel.example.com");
    expect(policy.normalisePanelUrl("panel.example.com:3001//")).toBe("https://panel.example.com:3001");
    expect(policy.normalisePanelUrl("garage:3001")).toBe("https://garage:3001");
    // A scheme the user typed stays.
    expect(policy.normalisePanelUrl("http://panel.example.com")).toBe("http://panel.example.com");
    expect(policy.normalisePanelUrl("  ")).toBe("");
  });

  it("accepts https:// anywhere and http:// on the user's own network", () => {
    expect(policy.checkPanelUrl("https://panel.example.com:3001", [])).toMatchObject({ ok: true, insecureAllowed: false });
    expect(policy.checkPanelUrl("http://192.168.1.20:3001", [])).toMatchObject({ ok: true, insecureAllowed: false });
  });

  it("refuses http:// to a public host", () => {
    expect(policy.checkPanelUrl("http://panel.example.com:3001", [])).toMatchObject({
      ok: false,
      reason: "insecure",
      origin: "http://panel.example.com:3001",
      host: "panel.example.com:3001",
    });
  });

  it("allows plain http:// only for the exact origin the user allowed", () => {
    const allowed = ["http://garage:3001"];
    expect(policy.checkPanelUrl("http://garage:3001", allowed)).toMatchObject({ ok: true, insecureAllowed: true });
    expect(policy.checkPanelUrl("http://garage:3001/sub/path", allowed)).toMatchObject({ ok: true });
    expect(policy.checkPanelUrl("http://garage:3002", allowed)).toMatchObject({ ok: false, reason: "insecure" });
    expect(policy.checkPanelUrl("http://garage.attacker.example:3001", allowed)).toMatchObject({ ok: false });
    expect(policy.checkPanelUrl("http://garage:3001", "http://garage:3001")).toMatchObject({ ok: false });
  });

  // Adversary pass: ways to make a public host look local, or to smuggle
  // something past the check.
  it.each([
    ["http://192.168.1.20@attacker.example", "invalid"],
    ["http://attacker.example#@192.168.1.20", "insecure"],
    ["http://attacker.example\\@192.168.1.20", "insecure"],
    ["http://user:pass@192.168.1.20:3001", "invalid"],
    ["ftp://192.168.1.20", "invalid"],
    ["javascript:alert(1)", "invalid"],
    ["file:///etc/passwd", "invalid"],
    ["not a url", "invalid"],
  ])("refuses %s (%s)", (url, reason) => {
    expect(policy.checkPanelUrl(url, [])).toMatchObject({ ok: false, reason });
  });

  it("explains the refusal and how to get past it", () => {
    const message = policy.panelUrlProblem(policy.checkPanelUrl("http://panel.example.com:3001", []));
    expect(message).toContain("https://panel.example.com:3001");
    expect(message).toContain("Allow plain HTTP");
  });
});

describe("Steam Sync popup: nothing secret leaves over a refused URL", () => {
  let storage;
  let fetch;
  let context;
  beforeEach(() => {
    storage = {};
    fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ accessToken: "access-1" }) }));
    const elements = {};
    const element = (id) =>
      (elements[id] ??= { value: "", checked: false, disabled: false, hidden: true, dataset: {}, textContent: "", addEventListener() {} });
    context = vm.createContext({
      chrome: {
        storage: {
          local: {
            get: (keys, done) =>
              done(Object.fromEntries([keys].flat().filter((key) => key in storage).map((key) => [key, structuredClone(storage[key])]))),
            set: (items, done) => {
              Object.assign(storage, structuredClone(items));
              done?.();
            },
            remove: (keys, done) => {
              for (const key of [keys].flat()) delete storage[key];
              done?.();
            },
          },
        },
        cookies: { get: (_details, done) => done(null) },
        permissions: { request: (_request, done) => done(true) },
      },
      document: { getElementById: element, addEventListener() {} },
      fetch,
      URL,
    });
    context.elements = elements;
    vm.runInContext(fs.readFileSync(URL_POLICY, "utf8"), context, { filename: URL_POLICY });
    vm.runInContext(fs.readFileSync(POPUP, "utf8"), context, { filename: POPUP });
  });

  it("neither signs in nor pushes cookies over http:// to a public host", async () => {
    await expect(context.loginToPanel("http://panel.example.com:3001", "admin", "secret")).rejects.toThrow(/unencrypted/);
    await expect(context.pushCookies("http://panel.example.com:3001", "token", "sid", "login")).rejects.toThrow(/unencrypted/);
    await expect(context.ensurePanelPermission("http://panel.example.com:3001")).rejects.toThrow(/unencrypted/);
    expect(fetch).not.toHaveBeenCalled();
    // The refusal offers the per-origin override.
    expect(context.elements["allow-http-row"].hidden).toBe(false);
    expect(context.elements["allow-http-row"].dataset.origin).toBe("http://panel.example.com:3001");
  });

  it("sends to an http:// origin the user allowed, and to that origin only", async () => {
    await context.setOriginAllowedOverHttp("http://panel.example.com:3001", true);
    await expect(context.loginToPanel("http://panel.example.com:3001", "admin", "secret")).resolves.toBe("access-1");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(context.loginToPanel("http://panel.example.com:8080", "admin", "secret")).rejects.toThrow(/unencrypted/);
    expect(fetch).toHaveBeenCalledTimes(1);

    await context.setOriginAllowedOverHttp("http://panel.example.com:3001", false);
    await expect(context.loginToPanel("http://panel.example.com:3001", "admin", "secret")).rejects.toThrow(/unencrypted/);
    expect(storage.insecureHttpOrigins).toEqual([]);
  });

  it("never follows a redirect with the password or the cookies", async () => {
    await context.loginToPanel("https://panel.example.com", "admin", "secret");
    await context.pushCookies("https://panel.example.com", "access-1", "sid", "login");
    expect(fetch.mock.calls[0][1].redirect).toBe("error");
    expect(fetch.mock.calls[1][1].redirect).toBe("error");
  });

  it("fills in https:// for a public panel typed without a scheme", () => {
    expect(context.normaliseUrl("panel.example.com:3001")).toBe("https://panel.example.com:3001");
    expect(context.normaliseUrl("192.168.1.20:3001")).toBe("http://192.168.1.20:3001");
  });

  it("is loaded before popup.js", () => {
    const html = fs.readFileSync(path.resolve(here, "../../browser-extension/popup.html"), "utf8");
    expect(html.indexOf('<script src="urlPolicy.js"></script>')).toBeGreaterThan(-1);
    expect(html.indexOf('<script src="urlPolicy.js"></script>')).toBeLessThan(html.indexOf('<script src="popup.js"></script>'));
    expect(html).toContain('id="allow-http-row" hidden');
  });

  // The executable embeds, and every install zips, browser-extension/ from
  // a fixed file list (server/utils/embeddedExtension.js): a file left out
  // of it ships an extension whose popup can't load its policy.
  it("ships every extension file in the panel's bundle", async () => {
    const { EXTENSION_FILES } = await import("../utils/embeddedExtension.js");
    const onDisk = fs.readdirSync(path.resolve(here, "../../browser-extension")).sort();
    expect([...EXTENSION_FILES].sort()).toEqual(onDisk);
  });
});
