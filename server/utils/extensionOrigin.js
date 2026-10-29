// Browser extension popups (the Steam Sync extension in browser-extension/)
// call the panel from chrome-extension://<id> and the like, with a Bearer
// token rather than the refresh cookie. Checked on the raw string: Node's
// URL.origin is the literal "null" for these schemes.
//
// Used by server/index.js (CORS: which extensions may call the panel) and
// routes/auth.js (POST /login: no refresh session or cookie for it, since a
// cookie the extension's sign-in sets lands in the browser's shared jar and
// replaces the panel tab's own).
export function isExtensionOrigin(origin) {
  if (typeof origin !== "string") return false;
  const lower = origin.toLowerCase();
  return (
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("moz-extension://") ||
    lower.startsWith("safari-web-extension://")
  );
}

// One extension's origin as the operator can name it under Settings >
// Remote Access, lower case: chrome-extension://<32 letters>,
// moz-extension://<uuid>, safari-web-extension://<uuid>. Anything else (a
// path, a port, a dot, user info) is not an origin a browser sends for an
// extension: null.
const EXTENSION_ORIGIN_RE = /^(chrome-extension|moz-extension|safari-web-extension):\/\/([a-z0-9-]{1,128})\/?$/;

export function normalizeExtensionOrigin(origin) {
  if (typeof origin !== "string") return null;
  const match = EXTENSION_ORIGIN_RE.exec(origin.trim().toLowerCase());
  return match ? `${match[1]}://${match[2]}` : null;
}
