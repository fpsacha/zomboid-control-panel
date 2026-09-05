import fs from "fs";

export const UPLOAD_TOO_LARGE_CODE = "UPLOAD_TOO_LARGE";
export const UPLOAD_BAD_SIGNATURE_CODE = "UPLOAD_BAD_SIGNATURE";

// Streams a request body straight to disk instead of buffering it in
// memory first. bug hunt 2026-09-05 (backup-restore-round-trip sweep,
// item #5): routes/backup.js's POST /upload used express.raw({ limit:
// 4GB }), which fully buffers the entire request body into ONE in-process
// Buffer (via the raw-body package's Buffer.concat over every chunk seen
// so far) before the route handler ever runs -- a completely ordinary
// multi-GB world backup upload could hold that many bytes resident at
// once, on top of whatever the panel is otherwise using, on a host sized
// for a game server rather than for buffering its own backups. Peak
// memory here is bounded by the stream's internal buffering (a handful of
// chunks), not by the upload's total size.
//
// Enforces the same two checks the old buffered version did, but WHILE
// streaming rather than after fully receiving the body: the zip
// local-file-header signature ("PK\x03\x04") and the size ceiling. The
// signature check accumulates bytes across chunks until it has 4 -- a
// single `data` event is not guaranteed to align with the first 4
// logical bytes of the body (TCP/HTTP chunking can split it), so checking
// only the FIRST chunk the way the old buffered code implicitly could
// (it saw the whole body at once) would misclassify a genuine zip whose
// signature happened to arrive split across two reads.
export function streamUploadToFile(req, tmpPath, maxBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let aborted = false;
    let totalBytes = 0;
    let sigBuffer = Buffer.alloc(0);
    let sigChecked = false;

    const writeStream = fs.createWriteStream(tmpPath);

    // Only removes tmpPath on a FAILURE path -- never on success, where
    // the caller still needs it to rename into place. writeStream's
    // 'close' (fd actually released) fires on every path, success
    // included, so this can't unlink unconditionally there; a flag set
    // only by the failure paths below gates it. Waiting for 'close'
    // rather than unlinking immediately on abort/error matters
    // specifically on Windows, where deleting a file while its handle is
    // still open fails (EBUSY/EPERM) instead of just being a race.
    let shouldCleanupTmp = false;
    writeStream.on("close", () => {
      if (shouldCleanupTmp) fs.unlink(tmpPath, () => {});
    });

    const cleanupListeners = () => {
      req.removeListener("data", onData);
      req.removeListener("error", onReqError);
      req.removeListener("aborted", onReqAborted);
      writeStream.removeListener("error", onWriteError);
      writeStream.removeListener("finish", onFinish);
    };

    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      if (err) reject(err);
      else resolve(value);
    };

    // Stops mid-stream: unpipes and destroys both sides so neither keeps
    // buffering or writing once a violation is found, then settles once.
    const abort = (code, message) => {
      if (aborted || settled) return;
      aborted = true;
      shouldCleanupTmp = true;
      req.unpipe(writeStream);
      writeStream.destroy();
      req.destroy();
      settle(Object.assign(new Error(message), { code }));
    };

    const onData = (chunk) => {
      totalBytes += chunk.length;

      if (!sigChecked) {
        sigBuffer =
          sigBuffer.length > 0 ? Buffer.concat([sigBuffer, chunk]) : chunk;
        if (sigBuffer.length >= 4) {
          sigChecked = true;
          if (sigBuffer[0] !== 0x50 || sigBuffer[1] !== 0x4b) {
            abort(
              UPLOAD_BAD_SIGNATURE_CODE,
              "File does not look like a valid .zip archive.",
            );
            return;
          }
        }
      }

      if (totalBytes > maxBytes) {
        abort(UPLOAD_TOO_LARGE_CODE, "Upload exceeds the configured size limit.");
      }
    };
    const onReqError = (err) => {
      shouldCleanupTmp = true;
      writeStream.destroy();
      settle(err);
    };
    const onReqAborted = () => {
      shouldCleanupTmp = true;
      writeStream.destroy();
      settle(new Error("Upload aborted by client"));
    };
    const onWriteError = (err) => {
      // writeStream errored on its own (ENOSPC, EACCES, ...) -- it
      // self-destroys (Node's fs.WriteStream defaults autoDestroy: true),
      // which will still fire 'close' on its own; no explicit destroy()
      // needed here, just mark the tmp file for cleanup once it does.
      shouldCleanupTmp = true;
      settle(err);
    };
    const onFinish = () => {
      // The stream ended before ever accumulating 4 bytes to check --
      // either genuinely empty (totalBytes === 0, "no file" is the
      // caller's job to report) or too short to possibly be a zip.
      if (totalBytes > 0 && !sigChecked) {
        shouldCleanupTmp = true;
        settle(
          Object.assign(
            new Error("File does not look like a valid .zip archive."),
            { code: UPLOAD_BAD_SIGNATURE_CODE },
          ),
        );
        return;
      }
      settle(null, totalBytes);
    };

    req.on("data", onData);
    req.on("error", onReqError);
    req.on("aborted", onReqAborted);
    writeStream.on("error", onWriteError);
    writeStream.on("finish", onFinish);
    req.pipe(writeStream);
  });
}
