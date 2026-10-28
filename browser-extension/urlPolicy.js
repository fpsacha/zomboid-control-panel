/* Zomboid Control Panel — Steam Sync: which panel URLs the popup may use.
 *
 * The popup sends the panel password and the Steam session cookies
 * (sessionid + steamLoginSecure, enough to act as the user on Steam) to the
 * panel URL. Over plain http:// anyone on the way can read them, so http://
 * is only used for a host on the user's own network -- loopback, private and
 * link-local addresses, and .local / .lan / .home.arpa / .internal /
 * .localhost names -- or for one origin the user explicitly allowed
 * (allowedInsecureOrigins, kept per origin by popup.js). Anything else needs
 * https://.
 *
 * A plain script, not a module: popup.html loads it before popup.js (its
 * functions are globals there), and the tests run it in a vm context.
 */

const LOCAL_NAME_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.localhost'];

function parseIPv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

// 127/8 loopback, 10/8, 172.16/12 and 192.168/16 private (RFC 1918),
// 169.254/16 link-local.
function isLocalIPv4(octets) {
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// Eight 16-bit groups, or null. Accepts "::" and a dotted IPv4 tail; the URL
// parser hands over the compressed lower-case hex form.
function parseIPv6(text) {
  let host = text;
  let tail = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (dotted) {
    const octets = parseIPv4(dotted[2]);
    if (!octets) return null;
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    host = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1);
  }
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (![...head, ...rest].every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const zeros = new Array(8 - known).fill(0);
  return [...head.map((g) => parseInt(g, 16)), ...zeros, ...rest.map((g) => parseInt(g, 16)), ...tail];
}

// ::1 loopback, fc00::/7 unique local, fe80::/10 link-local, and an
// IPv4-mapped address (::ffff:a.b.c.d) by its IPv4 rule.
function isLocalIPv6(groups) {
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isLocalIPv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  return false;
}

// hostname as URL#hostname gives it (lower case, IPv6 in brackets, IPv4 in
// dotted decimal whatever form was typed).
function isLocalNetworkHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost') return true;
  if (host.startsWith('[') && host.endsWith(']')) {
    const groups = parseIPv6(host.slice(1, -1));
    return groups ? isLocalIPv6(groups) : false;
  }
  const octets = parseIPv4(host);
  if (octets) return isLocalIPv4(octets);
  return LOCAL_NAME_SUFFIXES.some((suffix) => host.length > suffix.length && host.endsWith(suffix));
}

// This computer only: localhost, *.localhost, 127/8, ::1 (and its
// IPv4-mapped form). No other network can answer there.
function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.startsWith('[') && host.endsWith(']')) {
    const groups = parseIPv6(host.slice(1, -1));
    if (!groups) return false;
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
    return groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff && groups[6] >> 8 === 127;
  }
  const octets = parseIPv4(host);
  return !!octets && octets[0] === 127;
}

// What the user typed, as a URL. Without a scheme: http:// for a host on
// their own network, https:// for anything else. Trailing slashes go.
function normalisePanelUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let host = '';
    try {
      host = new URL('http://' + url).hostname;
    } catch (_) {
      host = '';
    }
    url = (host && isLocalNetworkHost(host) ? 'http://' : 'https://') + url;
  }
  return url.replace(/\/+$/, '');
}

// { ok: true, origin, host, insecureAllowed } or
// { ok: false, reason: 'invalid' | 'insecure', origin, host }.
function checkPanelUrl(panelUrl, allowedInsecureOrigins) {
  let url;
  try {
    url = new URL(panelUrl);
  } catch (_) {
    return { ok: false, reason: 'invalid', origin: null, host: null };
  }
  const result = { origin: url.origin, host: url.host };
  // A user name or password in the URL would ride along to the panel (and
  // fetch refuses such a URL anyway).
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    return { ...result, ok: false, reason: 'invalid' };
  }
  if (url.protocol === 'https:' || isLocalNetworkHost(url.hostname)) {
    return { ...result, ok: true, insecureAllowed: false };
  }
  const allowed = Array.isArray(allowedInsecureOrigins) && allowedInsecureOrigins.includes(url.origin);
  return allowed ? { ...result, ok: true, insecureAllowed: true } : { ...result, ok: false, reason: 'insecure' };
}

function panelUrlProblem(result) {
  if (result.reason === 'insecure') {
    return (
      `${result.host} is not on your own network, so the panel password and your Steam cookies would cross ` +
      `the internet unencrypted over http://. Use https://${result.host} instead. If ${result.host} really is ` +
      'on your own network, tick "Allow plain HTTP" below for it.'
    );
  }
  return 'Enter the panel address as https://host:port (http:// only for a panel on your own network).';
}
