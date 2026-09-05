import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import net from "net";
import { setupHttpsServer, isHttpsServerActive } from "../index.js";

// Regression coverage for the HTTPS-boot crash: a bad httpsCertPath/
// httpsKeyPath/httpsPort saved via Settings used to be able to take the
// WHOLE panel process down on the next restart (loadOrCreateCerts()
// throwing uncaught on a directory path, or httpsServer.listen() erroring
// with no "error" handler attached) -- not just disable HTTPS. The
// load-bearing case is NEGATIVE: the panel must still be alive and serving
// after a bad value, not just "HTTPS behaves correctly when nothing is
// wrong". A fix that merely disabled HTTPS unconditionally would also pass
// a naive "doesn't crash" test, so the last case below proves a genuinely
// valid config still brings HTTPS up.

const serversToClose = [];

afterEach(async () => {
  await Promise.all(
    serversToClose.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          if (server.listening) server.close(() => resolve());
          else resolve();
        }),
    ),
  );
});

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

describe("setupHttpsServer -- boot must never crash the process", () => {
  it("returns null and does nothing when HTTPS is disabled", () => {
    const result = setupHttpsServer({
      httpsEnabled: false,
      httpsPort: 3443,
      customKeyPath: "",
      customCertPath: "",
    });
    expect(result).toBeNull();
  });

  it("a directory as the custom cert path does NOT crash -- falls back to self-signed and HTTPS still comes up", async () => {
    const port = await getFreePort();
    let server;
    expect(() => {
      server = setupHttpsServer({
        httpsEnabled: true,
        httpsPort: port,
        // A directory, not a file -- exactly the EISDIR case that used to
        // throw straight out of loadOrCreateCerts() uncaught.
        customKeyPath: process.cwd(),
        customCertPath: process.cwd(),
      });
    }).not.toThrow();

    expect(server).not.toBeNull();
    serversToClose.push(server);

    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    expect(server.listening).toBe(true);
  });

  it("a colliding httpsPort does NOT crash -- HTTPS fails closed (server nulls itself out) instead of taking the process down", async () => {
    // Occupy a real port first so the HTTPS listen collides with it.
    // Deliberately NOT passing a host here -- must match setupHttpsServer's
    // own httpsServer.listen(httpsPort) call (no host given, binds all
    // interfaces), since binding one specific interface's copy of a port
    // doesn't reliably collide with a later all-interfaces bind of the same
    // port on every platform.
    const blocker = net.createServer();
    serversToClose.push(blocker);
    const port = await new Promise((resolve) => {
      blocker.listen(0, () => resolve(blocker.address().port));
    });

    let server;
    expect(() => {
      server = setupHttpsServer({
        httpsEnabled: true,
        httpsPort: port,
        customKeyPath: "",
        customCertPath: "",
      });
    }).not.toThrow();

    // setupHttpsServer() returns synchronously, before the async
    // EADDRINUSE 'error' event has had a chance to fire -- this is exactly
    // the race the fix has to survive without an uncaught exception.
    expect(server).not.toBeNull();

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("expected an 'error' event, none fired")),
        2000,
      );
      server.once("error", (err) => {
        clearTimeout(timeout);
        expect(err.code).toBe("EADDRINUSE");
        resolve();
      });
    });
    expect(server.listening).toBe(false);
    // bug hunt 2026-08-31-c (under-coverage sweep): the title's own
    // parenthetical -- "(server nulls itself out)" -- names the module-level
    // `httpsServer` binding setupHttpsServer() resets on this error path, a
    // DIFFERENT reference from the `server` object this test already holds
    // (that local reference's own `.listening` going false above proves the
    // "fails closed" half, but can never prove the module's own state was
    // reset -- reassigning a module-level variable doesn't touch a
    // caller's separately-held reference to the old value). Without this,
    // a regression that dropped the `httpsServer = null` reassignment
    // (e.g. leaving the boot-banner's later `if (httpsServer)` check lying
    // about HTTPS availability after a failed bind) would pass this test
    // unnoticed.
    expect(isHttpsServerActive()).toBe(false);
  });

  it("a custom cert path that is a real, readable file but not a valid certificate does NOT crash -- fails closed instead of throwing out of https.createServer()", () => {
    // loadOrCreateCerts() only checks existsSync/statSync().isFile() and
    // that the bytes are readable -- it never validates the CONTENT is a
    // parseable PEM/DER cert. A file that satisfies both of those (regular
    // file, readable) but holds garbage bytes -- corrupted on disk,
    // truncated by a partial write, or just a wrong file the operator
    // pointed the setting at -- reaches https.createServer() unchanged,
    // which throws SYNCHRONOUSLY on invalid content. That throw used to
    // propagate straight out of setupHttpsServer() with no guard around
    // it, past start()'s outer try/catch, into `log.error("Failed to
    // start server")` + `process.exit(1)` -- taking the WHOLE panel down,
    // including the plain HTTP listener that hadn't even started
    // listening yet at that point in boot. Same failure class as the
    // EISDIR case above; this is the "valid file, invalid content" sibling
    // that check never covered.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-badcert-"));
    const keyPath = path.join(tmpDir, "not-a-key.pem");
    const certPath = path.join(tmpDir, "not-a-cert.pem");
    fs.writeFileSync(keyPath, "this is not a PEM key\n");
    fs.writeFileSync(certPath, "this is not a PEM cert\n");

    let server;
    try {
      expect(() => {
        server = setupHttpsServer({
          httpsEnabled: true,
          httpsPort: 3443,
          customKeyPath: keyPath,
          customCertPath: certPath,
        });
      }).not.toThrow();
      expect(server === null || server.listening === false).toBe(true);
      if (server && server.listening) serversToClose.push(server);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("an out-of-range httpsPort does NOT crash -- fails closed synchronously", () => {
    let server;
    expect(() => {
      server = setupHttpsServer({
        httpsEnabled: true,
        httpsPort: 999999,
        customKeyPath: "",
        customCertPath: "",
      });
    }).not.toThrow();
    // Node validates the port synchronously for a value this far out of
    // range -- no 'error' event to wait for, the throw already happened
    // and was caught inside setupHttpsServer().
    if (server) serversToClose.push(server);
    expect(server === null || server.listening === false).toBe(true);
  });

  it("a genuinely valid config still brings HTTPS up -- the fix must not just disable the feature", async () => {
    const port = await getFreePort();

    const server = setupHttpsServer({
      httpsEnabled: true,
      httpsPort: port,
      customKeyPath: "",
      customCertPath: "",
    });

    expect(server).not.toBeNull();
    serversToClose.push(server);

    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    expect(server.listening).toBe(true);
    expect(server.address().port).toBe(port);
  });
});
