/**
 * HTTPS Certificate Utility
 * Generates self-signed certificates for HTTPS support.
 * Also supports loading user-provided certificates.
 *
 * Certificates are stored in data/certs/ directory.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import { getDataPaths } from '../utils/paths.js';

const log = createLogger('HTTPS');

const { dataDir } = getDataPaths();
const CERT_DIR = path.join(dataDir, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'server.key');
const CERT_FILE = path.join(CERT_DIR, 'server.cert');

/**
 * Generate a self-signed certificate using Node.js crypto
 * Uses the X509Certificate API available in Node 15+
 */
function generateSelfSignedCert() {
  log.info('Generating self-signed certificate...');

  // Generate RSA key pair
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Create self-signed certificate using Node's built-in X509 support
  // Node 18+ has crypto.X509Certificate but not a signing API, so we use
  // a minimal ASN.1/DER approach via createSign
  const cert = createSelfSignedCertPEM(privateKey, publicKey);

  return { key: privateKey, cert };
}

/**
 * Create a minimal self-signed X.509 certificate in PEM format
 * This uses DER/ASN.1 encoding directly — no OpenSSL dependency needed.
 */
function createSelfSignedCertPEM(privateKeyPem, publicKeyPem) {
  // Parse the public key from PEM to DER
  const pubKeyDer = pemToDer(publicKeyPem, 'PUBLIC KEY');

  // Subject/Issuer: CN=Zomboid Control Panel
  const subject = derSequence([
    derSet([
      derSequence([
        derOID([2, 5, 4, 3]), // commonName
        derUTF8String('Zomboid Control Panel'),
      ]),
    ]),
  ]);

  // Validity: now to +365 days
  const now = new Date();
  const notAfter = new Date(now);
  notAfter.setFullYear(notAfter.getFullYear() + 1);

  const validity = derSequence([
    derUTCTime(now),
    derUTCTime(notAfter),
  ]);

  // Serial number (random)
  const serial = derInteger(crypto.randomBytes(8));

  // Signature algorithm: SHA-256 with RSA
  const sigAlgo = derSequence([
    derOID([1, 2, 840, 113549, 1, 1, 11]), // sha256WithRSAEncryption
    derNull(),
  ]);

  // TBS (To-Be-Signed) Certificate
  const tbs = derSequence([
    derExplicit(0, derInteger(Buffer.from([2]))), // version v3
    serial,
    sigAlgo,
    subject, // issuer = subject (self-signed)
    validity,
    subject, // subject
    pubKeyDer, // subjectPublicKeyInfo (already DER-encoded)
  ]);

  // Sign the TBS with SHA-256 + RSA
  const signer = crypto.createSign('SHA256');
  signer.update(tbs);
  const signature = signer.sign(privateKeyPem);

  // Wrap signature in BIT STRING
  const sigBitString = Buffer.concat([
    Buffer.from([0x03, ...derLength(signature.length + 1), 0x00]),
    signature,
  ]);

  // Full certificate
  const cert = derSequence([tbs, sigAlgo, sigBitString]);

  // Convert to PEM
  const b64 = cert.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

// ── ASN.1 DER encoding helpers ──

function derLength(len) {
  if (len < 128) return [len];
  const bytes = [];
  let tmp = len;
  while (tmp > 0) {
    bytes.unshift(tmp & 0xff);
    tmp >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derTag(tag, content) {
  const contentBuf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([
    Buffer.from([tag, ...derLength(contentBuf.length)]),
    contentBuf,
  ]);
}

function derSequence(items) {
  const content = Buffer.concat(items.map(i => (Buffer.isBuffer(i) ? i : Buffer.from(i))));
  return derTag(0x30, content);
}

function derSet(items) {
  const content = Buffer.concat(items.map(i => (Buffer.isBuffer(i) ? i : Buffer.from(i))));
  return derTag(0x31, content);
}

function derInteger(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // Ensure positive (add leading zero if high bit set)
  const needsPad = b[0] & 0x80;
  const content = needsPad ? Buffer.concat([Buffer.from([0x00]), b]) : b;
  return derTag(0x02, content);
}

function derOID(components) {
  const bytes = [40 * components[0] + components[1]];
  for (let i = 2; i < components.length; i++) {
    let val = components[i];
    if (val < 128) {
      bytes.push(val);
    } else {
      const encoded = [];
      encoded.unshift(val & 0x7f);
      val >>= 7;
      while (val > 0) {
        encoded.unshift((val & 0x7f) | 0x80);
        val >>= 7;
      }
      bytes.push(...encoded);
    }
  }
  return derTag(0x06, Buffer.from(bytes));
}

function derNull() {
  return Buffer.from([0x05, 0x00]);
}

function derUTF8String(str) {
  return derTag(0x0c, Buffer.from(str, 'utf8'));
}

function derUTCTime(date) {
  const y = (date.getUTCFullYear() % 100).toString().padStart(2, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  const h = date.getUTCHours().toString().padStart(2, '0');
  const min = date.getUTCMinutes().toString().padStart(2, '0');
  const s = date.getUTCSeconds().toString().padStart(2, '0');
  return derTag(0x17, Buffer.from(`${y}${m}${d}${h}${min}${s}Z`, 'ascii'));
}

function derExplicit(tag, content) {
  const contentBuf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([
    Buffer.from([0xa0 | tag, ...derLength(contentBuf.length)]),
    contentBuf,
  ]);
}

function pemToDer(pem, label) {
  const b64 = pem
    .replace(`-----BEGIN ${label}-----`, '')
    .replace(`-----END ${label}-----`, '')
    .replace(/\s/g, '');
  return Buffer.from(b64, 'base64');
}

// ── Public API ──

/**
 * Ensure certificates exist (generate if needed) and return paths.
 * Returns null if HTTPS should not be used.
 */
export function loadOrCreateCerts(customKeyPath, customCertPath) {
  // Check for custom certs first. Never let a bad custom path (missing,
  // a directory instead of a file, unreadable) throw out of this
  // function -- existsSync alone doesn't rule out a directory, and a
  // path that was a valid file when the setting was saved can still be
  // moved/deleted/permission-changed before the panel next restarts.
  // Falling through to the self-signed branch below on ANY problem here
  // is what keeps a bad custom-cert setting from taking the whole panel
  // down (see server/routes/config.js's PUT /app-settings for the other
  // half of this fix -- validating at save time so this path is rarely
  // hit for real, not a substitute for it).
  if (customKeyPath && customCertPath) {
    try {
      const keyIsFile = fs.statSync(customKeyPath).isFile();
      const certIsFile = fs.statSync(customCertPath).isFile();
      if (keyIsFile && certIsFile) {
        log.info(`Using custom certificates: ${customCertPath}`);
        return {
          key: fs.readFileSync(customKeyPath),
          cert: fs.readFileSync(customCertPath),
        };
      }
      log.warn('Custom certificate paths specified but one or both are not regular files — falling back to self-signed');
    } catch (error) {
      log.warn(`Custom certificate paths specified but could not be read (${error.message}) — falling back to self-signed`);
    }
  }

  // Check for existing self-signed certs
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) {
    log.info('Using existing self-signed certificate');
    return {
      key: fs.readFileSync(KEY_FILE),
      cert: fs.readFileSync(CERT_FILE),
    };
  }

  // Generate new self-signed cert
  try {
    if (!fs.existsSync(CERT_DIR)) {
      fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
    }
    try {
      fs.chmodSync(CERT_DIR, 0o700);
    } catch {
      /* best-effort: Windows / network shares */
    }

    const { key, cert } = generateSelfSignedCert();
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
    // mode above only applies when writeFileSync CREATES the file -- if
    // server.key already existed (e.g. only server.cert was missing, so
    // this branch regenerates both into a fresh pair) with a looser mode
    // from some earlier state, the fresh private key just written into it
    // would otherwise inherit that stale permission. Same explicit
    // chmodSync-after-write pattern as jwtSecret.js/uiSecretFile.js/
    // serverRconSecrets.js use for every other secret file.
    try {
      fs.chmodSync(KEY_FILE, 0o600);
    } catch {
      /* best-effort: Windows / network shares */
    }
    fs.writeFileSync(CERT_FILE, cert, { mode: 0o644 });

    log.info(`Self-signed certificate generated at ${CERT_DIR}`);
    return { key: Buffer.from(key), cert: Buffer.from(cert) };
  } catch (error) {
    log.error(`Failed to generate certificate: ${error.message}`);
    return null;
  }
}

/**
 * Get cert file paths
 */
export function getCertPaths() {
  return { keyPath: KEY_FILE, certPath: CERT_FILE, certDir: CERT_DIR };
}
