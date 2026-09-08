/**
 * Shared network-interface enumeration.
 *
 * Extracted from ServerManager.listNetworkInterfaces() (2026-09-08,
 * god-dispatched cert SAN fix) so server/utils/certs.js can reuse the exact
 * same enumeration without importing the whole ServerManager class (a large
 * stateful service with child_process/net/Steam-operation dependencies that
 * would be a heavy, side-effect-bearing import for a pure address lookup).
 * ServerManager.listNetworkInterfaces() now delegates here -- same logic,
 * same object shape, one definition.
 */
import os from "os";

/**
 * All non-internal IPv4 addresses currently present on the host, e.g. one
 * per VPN mesh (Tailscale, ZeroTier) plus the real LAN adapter.
 */
export function listNonInternalIPv4Interfaces() {
  const interfaces = os.networkInterfaces();
  const result = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        result.push({ name, address: iface.address });
      }
    }
  }
  return result;
}
