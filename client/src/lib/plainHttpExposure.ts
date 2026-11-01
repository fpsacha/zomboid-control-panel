// True when the panel is opened over plain http from an address that is not
// local or private: the login and session then cross the Internet unencrypted.
// Loopback, private-range IPs, single-label and .local/.lan/.internal names
// are treated as local; a reverse proxy with TLS shows up as https.
export function isPlainHttpExposed(protocol: string, hostname: string): boolean {
  if (protocol !== 'http:') return false
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host.includes(':')) return !(host === '::1' || /^f[cd]/.test(host) || host.startsWith('fe80'))
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])]
    const local = a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
    return !local
  }
  if (!host.includes('.')) return false
  return !/\.(local|lan|internal|home|home\.arpa|localdomain)$/.test(host)
}
