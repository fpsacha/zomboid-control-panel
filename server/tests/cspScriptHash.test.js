import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const { computeInlineScriptCspHash } = await import(
  "../utils/cspScriptHash.js"
);

function sha256Base64(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("base64");
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-cspscripthash-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeIndexHtml(content) {
  fs.writeFileSync(path.join(tmpDir, "index.html"), content, "utf8");
}

describe("computeInlineScriptCspHash — present and matching", () => {
  it("returns a sha256 CSP source matching the EXACT bytes of the inline script content", () => {
    const scriptBody = "\n      console.log('anti-fouc');\n    ";
    writeIndexHtml(
      `<!DOCTYPE html><html><head><script>${scriptBody}</script></head></html>`,
    );

    const result = computeInlineScriptCspHash(tmpDir);

    const expectedHash = sha256Base64(scriptBody);
    expect(result).toBe(`'sha256-${expectedHash}'`);
  });

  it("matches the real client/dist/index.html shipped with this repo, if it has been built", (ctx) => {
    // Not mocked — reads the real built file to prove this isn't just
    // correct against a hand-crafted fixture. Skips itself if the client
    // hasn't been built in this environment, rather than failing for an
    // unrelated reason.
    //
    // Reports an actual SKIP (ctx.skip()), not a bare `return`: a bare
    // return here still counts as a PASS with zero assertions run, which is
    // exactly what every ubuntu CI checkout produced (client/dist is
    // gitignored and the server job never builds the client) -- a garbage
    // hash would have given the same green tick. A real skip shows up as
    // skipped in the run summary instead of silently inflating the pass count.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const realDistPath = path.join(here, "..", "..", "client", "dist");
    const realIndexPath = path.join(realDistPath, "index.html");
    if (!fs.existsSync(realIndexPath)) return ctx.skip(); // client not built in this environment

    const html = fs.readFileSync(realIndexPath, "utf8");
    const match = /<script>([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull(); // the anti-FOUC script must still be there

    const result = computeInlineScriptCspHash(realDistPath);
    const normalized = match[1].replace(/\r\n?/g, "\n");
    expect(result).toBe(`'sha256-${sha256Base64(normalized)}'`);
  });

  it("normalizes CRLF/CR line endings before hashing, matching what a real browser computes", () => {
    // Real CRLF bytes, not a JS "\n" escape (which is always LF and can
    // never reproduce this) -- this is what a checkout with
    // core.autocrlf=true actually produces for client/index.html, which has
    // no .gitattributes rule pinning it to LF.
    const scriptBodyCrlf = "\r\n      console.log('anti-fouc');\r\n    ";
    writeIndexHtml(
      `<!DOCTYPE html><html><head><script>${scriptBodyCrlf}</script></head></html>`,
    );

    const result = computeInlineScriptCspHash(tmpDir);

    // The browser's CSP engine newline-normalizes CRLF/CR -> LF during HTML
    // parsing before computing the script hash it enforces (spec-mandated).
    // Hashing the raw CRLF bytes computes a DIFFERENT hash than what the
    // browser actually checks against, so the allowed source never matches
    // and the browser blocks the script with a CSP violation on every load.
    const normalizedBody = scriptBodyCrlf.replace(/\r\n?/g, "\n");
    const expectedHash = sha256Base64(normalizedBody);
    expect(result).toBe(`'sha256-${expectedHash}'`);
  });

  it("does NOT match the module app-bundle script tag (has attributes) — only the bare inline one", () => {
    writeIndexHtml(
      `<html><head><script>const x = 1;</script><script type="module" src="/a.js"></script></head></html>`,
    );
    const result = computeInlineScriptCspHash(tmpDir);
    expect(result).toBe(`'sha256-${sha256Base64("const x = 1;")}'`);
  });
});

describe("computeInlineScriptCspHash — not found, must not fall back to unsafe-inline", () => {
  it("dist directory / index.html missing entirely -> returns null and logs loudly", () => {
    const log = { warn: vi.fn() };
    const result = computeInlineScriptCspHash(
      path.join(tmpDir, "does-not-exist"),
      log,
    );
    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not read"),
    );
  });

  it("index.html exists but has no bare inline <script> block -> returns null and logs loudly", () => {
    writeIndexHtml(
      `<html><head><script type="module" src="/a.js"></script></head></html>`,
    );
    const log = { warn: vi.fn() };
    const result = computeInlineScriptCspHash(tmpDir, log);
    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("no inline"),
    );
  });

  it("index.html has no script tags at all -> returns null and logs loudly", () => {
    writeIndexHtml(`<html><head></head><body>nothing here</body></html>`);
    const log = { warn: vi.fn() };
    const result = computeInlineScriptCspHash(tmpDir, log);
    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it("never throws even with no logger passed", () => {
    expect(() =>
      computeInlineScriptCspHash(path.join(tmpDir, "nope")),
    ).not.toThrow();
  });
});
