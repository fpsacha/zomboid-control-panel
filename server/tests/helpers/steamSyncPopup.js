import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// The Steam Sync popup (browser-extension/popup.js, after urlPolicy.js as
// popup.html loads them) in a vm context, with just enough of the
// WebExtensions API and the DOM stubbed out to drive doTest() and doSend()
// the way its buttons do.
//
// respond(request) answers every fetch: { status, body } (default 200 {}).
// request: { url, path, origin, method, headers, body (parsed JSON) }.

const EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../browser-extension");

export function loadSteamSyncPopup({
  respond = () => ({}),
  cookies = { sessionid: "steam-session", steamLoginSecure: "steam-login" },
} = {}) {
  const storage = {};
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: "",
        checked: false,
        disabled: false,
        hidden: false,
        dataset: {},
        textContent: "",
        className: "",
        addEventListener() {},
      });
    }
    return elements.get(id);
  };
  const requests = [];
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const request = {
      url,
      path: parsed.pathname,
      origin: parsed.origin,
      method: options.method || "GET",
      headers: options.headers || {},
      redirect: options.redirect,
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    requests.push(request);
    const { status = 200, body = {} } = (await respond(request)) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  const context = vm.createContext({
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
      cookies: { get: (details, done) => done(cookies[details.name] ? { value: cookies[details.name] } : null) },
      permissions: { request: (_request, done) => done(true) },
    },
    document: { getElementById: element, addEventListener() {} },
    fetch,
    URL,
    crypto: globalThis.crypto,
    TextEncoder,
    btoa,
    atob,
  });
  for (const file of ["urlPolicy.js", "popup.js"]) {
    const filename = path.join(EXTENSION, file);
    vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  }

  return {
    storage,
    requests,
    element,
    // Fill the setup form the way the user does.
    fill({ panelUrl, username, password, rememberPassword } = {}) {
      if (panelUrl !== undefined) element("panel-url").value = panelUrl;
      if (username !== undefined) element("username").value = username;
      if (password !== undefined) element("password").value = password;
      if (rememberPassword !== undefined) element("remember-password").checked = rememberPassword;
    },
    save: () => context.saveSettings(),
    test: () => context.doTest(),
    send: () => context.doSend(),
    setupStatus: () => element("setup-status").textContent,
    sendStatus: () => element("send-status").textContent,
    context,
  };
}
