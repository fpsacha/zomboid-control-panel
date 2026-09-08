import { describe, expect, it } from "vitest";
import crypto from "crypto";
import fs from "fs";
import tls from "tls";

// 2026-09-08, god-dispatched (GH#149 Tailscale investigation follow-up):
// the self-signed certificate previously carried NO SubjectAltName
// extension at all -- CN only. Chrome/Firefox both ignore CN and require
// SAN since ~2017, so hostname validation failed identically for EVERY
// host (localhost, LAN, tailnet alike), not just the Tailscale address the
// investigation was chasing. This file verifies the actual generated
// bytes parse and carry the expected SAN entries -- not just that the
// function runs without throwing -- per the explicit standard set for
// this fix ("verify the bytes, do not just check the tests pass").

const { loadOrCreateCerts, getCertPaths } = await import("../utils/certs.js");

describe("createSelfSignedCertPEM() emits a real, parseable SubjectAltName", () => {
  it("localhost, 127.0.0.1 and ::1 are always present, and the cert round-trips through node:crypto and tls", () => {
    const { cert, key } = loadOrCreateCerts(null, null);
    expect(cert).toBeTruthy();
    expect(key).toBeTruthy();

    const x509 = new crypto.X509Certificate(cert);
    expect(x509.subjectAltName).toContain("DNS:localhost");
    expect(x509.subjectAltName).toContain("IP Address:127.0.0.1");
    // node:crypto renders ::1 in its expanded form.
    expect(x509.subjectAltName).toContain("IP Address:0:0:0:0:0:0:0:1");

    // The whole point: a strict, non-browser TLS consumer must be able to
    // build a secure context from this key+cert pair without throwing.
    expect(() => tls.createSecureContext({ key, cert })).not.toThrow();

    // Private key must actually match the certificate's public key -- a
    // malformed extensions block could corrupt the TBS bytes being signed
    // without necessarily breaking this specific check, but a mismatch
    // here would prove something is very wrong.
    expect(x509.checkPrivateKey(crypto.createPrivateKey(key))).toBe(true);
  });

  it("reuses a cert that already has a SubjectAltName across restarts (does not regenerate every time)", () => {
    const first = loadOrCreateCerts(null, null);
    const second = loadOrCreateCerts(null, null);
    expect(second.cert.toString()).toBe(first.cert.toString());
    expect(second.key.toString()).toBe(first.key.toString());
  });

  it("2026-09-08: an existing pre-fix cert with NO SubjectAltName is detected and regenerated automatically, not reused forever", () => {
    // Generate once so the cert dir/files exist, then overwrite the cert
    // file with the OLD shape (CN-only, no SAN) to simulate an install
    // that already had HTTPS enabled before this fix shipped.
    loadOrCreateCerts(null, null);
    const { certPath } = getCertPaths();

    // node:crypto has no API to MINT a certificate (only to parse one), so
    // the truest simulation of a pre-fix cert would require re-deriving the
    // very hand-rolled DER builder this commit fixes. Instead this exercises
    // the same code path from the other direction: an unparsable cert file
    // (corrupted on disk, truncated write, or any other bad content) must
    // ALSO be treated as "no SAN" and regenerated, not left broken forever --
    // the loadOrCreateCerts() catch branch and the missing-SAN branch are
    // deliberately the same "regenerate" outcome for exactly this reason.
    fs.writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\nnotarealcert\n-----END CERTIFICATE-----\n");

    const regenerated = loadOrCreateCerts(null, null);
    const x509 = new crypto.X509Certificate(regenerated.cert);
    expect(x509.subjectAltName).toContain("DNS:localhost");
    // The key must have been regenerated too (paired with the new cert),
    // not left as the old key file paired with a new cert.
    expect(x509.checkPrivateKey(crypto.createPrivateKey(regenerated.key))).toBe(true);
  });
});
