import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Same getDataPaths() mock as panelBridgeSftp.test.js -- required so
// utils/logger.js's module-load-time getDataPaths() call (transitively
// imported via panelBridgeSftp.js) doesn't crash before any test body runs.
const mockDataPaths = vi.hoisted(() => {
  const base = (process.env.TEMP || process.env.TMPDIR || '/tmp') + '/panel-bridge-sftp-queuestate-test-default';
  return { current: () => ({ dataDir: base + '/data', logsDir: base + '/logs' }) };
});
vi.mock('../utils/paths.js', () => ({ getDataPaths: (...args) => mockDataPaths.current(...args) }));

const { PanelBridgeSftpTransport, validateSftpBridgeConfig } = await import('../services/panelBridgeSftp.js');

const valid = {
  host: 'pz.example.net',
  port: 22,
  username: 'panelbridge',
  password: 'not-a-real-secret',
  bridgePath: '/home/pz/Zomboid/Lua/panelbridge/TestServer',
  pollIntervalSeconds: 3,
};

const temporaryDirectories = [];

afterEach(() => {
  for (const temporaryDirectory of temporaryDirectories.splice(0)) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

function makeTempCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-sftp-queuestate-test-'));
  temporaryDirectories.push(dir);
  fs.mkdirSync(path.join(dir, 'inbox'));
  return dir;
}

// 2026-08-30 sftp-bridge-inbox-selfheal-is-nonfunctional: syncNow() uploaded
// inbox/cmd-*.json and downloaded status.json / queue-state-lua.json /
// outbox, but never uploaded .queue-state-node.json to the remote host at
// all -- so PanelBridge.lua's tryResyncInboxCursor (which reads exactly this
// file to detect and recover from an inbox counter desync) always saw nil
// over SFTP, and the entire self-heal path was silently inert for every
// remote bridge. These tests cover the fix: the file now gets uploaded, and
// -- the part that matters more than "it uploads" -- it uploads a snapshot
// that can never claim a command exists remotely before it actually does.
describe('readLocalQueueStateNodeSnapshot', () => {
  it('returns null when cachePath has not been set yet', () => {
    const transport = new PanelBridgeSftpTransport();
    expect(transport.readLocalQueueStateNodeSnapshot()).toBeNull();
  });

  it('returns null when no queue-state-node.json has been persisted yet', () => {
    const transport = new PanelBridgeSftpTransport();
    transport.cachePath = makeTempCache();
    expect(transport.readLocalQueueStateNodeSnapshot()).toBeNull();
  });

  it('returns null (not a throw) when the file is present but unparsable', () => {
    const transport = new PanelBridgeSftpTransport();
    transport.cachePath = makeTempCache();
    fs.writeFileSync(path.join(transport.cachePath, '.queue-state-node.json'), 'not-json');
    expect(transport.readLocalQueueStateNodeSnapshot()).toBeNull();
  });

  it('returns the parsed value when the file is present and well-formed', () => {
    const transport = new PanelBridgeSftpTransport();
    transport.cachePath = makeTempCache();
    const state = { protocolVersion: 'queue-v1', nextCommandSeq: 7, lastConsumedResultSeq: 2 };
    fs.writeFileSync(path.join(transport.cachePath, '.queue-state-node.json'), JSON.stringify(state));
    expect(transport.readLocalQueueStateNodeSnapshot()).toEqual(state);
  });
});

describe('uploadQueueStateNode', () => {
  it('uploads the snapshot to a temporary remote name before publishing it', async () => {
    const put = vi.fn(async () => {});
    const rename = vi.fn(async () => {});
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.transferId = 'test-transfer';
    transport.client = { exists: vi.fn(async () => false), put, rename, delete: vi.fn(async () => {}) };

    await transport.uploadQueueStateNode({ nextCommandSeq: 3, lastConsumedResultSeq: 1 });

    const remotePath = `${valid.bridgePath}/.queue-state-node.json`;
    expect(put).toHaveBeenCalledTimes(1);
    const [uploadedSource, uploadedRemotePath] = put.mock.calls[0];
    expect(uploadedRemotePath).toBe(`${remotePath}.test-transfer.uploading`);
    expect(Buffer.isBuffer(uploadedSource)).toBe(true);
    expect(JSON.parse(uploadedSource.toString('utf8'))).toEqual({ nextCommandSeq: 3, lastConsumedResultSeq: 1 });
    expect(rename).toHaveBeenCalledWith(`${remotePath}.test-transfer.uploading`, remotePath);
  });

  // GH #146: Godlike hosting's SFTP server refused every rename of the temp
  // upload onto .queue-state-node.json once that file already existed
  // remotely (which it does on every tick after the first) -- 20 consecutive
  // identical "_rename: failure" errors, never once succeeding, because
  // standard SFTP rename is specified to fail onto an existing destination
  // and this server doesn't implement the optional overwrite extension. Fix:
  // delete the old remote file (only after the new content is already
  // staged at the temp path) before renaming, so the overwrite never
  // depends on the remote supporting POSIX rename-replace semantics.
  it('deletes the existing remote file before renaming the new upload into place', async () => {
    const calls = [];
    const put = vi.fn(async () => { calls.push('put'); });
    const deleteRemote = vi.fn(async (target) => { calls.push(`delete:${target}`); });
    const rename = vi.fn(async () => { calls.push('rename'); });
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.transferId = 'test-transfer';
    transport.client = { exists: vi.fn(async () => '-'), put, rename, delete: deleteRemote };

    await transport.uploadQueueStateNode({ nextCommandSeq: 3, lastConsumedResultSeq: 1 });

    const remotePath = `${valid.bridgePath}/.queue-state-node.json`;
    expect(deleteRemote).toHaveBeenCalledWith(remotePath);
    expect(rename).toHaveBeenCalledWith(`${remotePath}.test-transfer.uploading`, remotePath);
    // Order matters: the new content must already be staged at the temp
    // path before the old file is destroyed, so a put failure never touches
    // the existing remote file.
    expect(calls).toEqual(['put', `delete:${remotePath}`, 'rename']);
  });

  it('does not attempt to delete a remote file that does not exist yet', async () => {
    const deleteRemote = vi.fn(async () => {});
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.transferId = 'test-transfer';
    transport.client = { exists: vi.fn(async () => false), put: vi.fn(async () => {}), rename: vi.fn(async () => {}), delete: deleteRemote };

    await transport.uploadQueueStateNode({ nextCommandSeq: 1 });

    expect(deleteRemote).not.toHaveBeenCalled();
  });

  it('removes a partial remote queue-state file when the upload fails', async () => {
    const deleteRemote = vi.fn(async () => {});
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.transferId = 'failed-transfer';
    transport.client = {
      exists: vi.fn(async () => false),
      put: vi.fn(async () => { throw new Error('Connection reset'); }),
      rename: vi.fn(async () => {}),
      delete: deleteRemote,
    };

    await expect(transport.uploadQueueStateNode({ nextCommandSeq: 1 })).rejects.toThrow('Connection reset');
    expect(deleteRemote).toHaveBeenCalledWith(
      `${valid.bridgePath}/.queue-state-node.json.failed-transfer.uploading`,
    );
  });

  it('refuses to treat a remote directory as the queue-state file', async () => {
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.client = { exists: vi.fn(async () => 'd') };

    await expect(transport.uploadQueueStateNode({ nextCommandSeq: 1 })).rejects.toThrow('occupied by a directory');
  });
});

describe('syncNow: queue-state upload ordering', () => {
  it('does not attempt to upload the queue-state file when nothing has been persisted locally yet', async () => {
    const put = vi.fn(async () => {});
    const transport = new PanelBridgeSftpTransport();
    transport.running = true;
    transport.config = validateSftpBridgeConfig(valid);
    transport.cachePath = makeTempCache();
    transport.client = { put };
    transport.ensureRemoteDirectories = vi.fn(async () => {});
    transport.uploadInbox = vi.fn(async () => {});
    transport.syncModFile = vi.fn(async () => {});
    transport.syncOutbox = vi.fn(async () => {});

    await transport.syncNow();

    expect(put).not.toHaveBeenCalled();
  });

  // The test that actually pins the fix for the hazard the header comments
  // describe, not just "it uploads something": the snapshot must be the
  // value from BEFORE uploadInbox() ran, even when the live file advances
  // DURING uploadInbox() -- exactly what a second, concurrent write (another
  // command enqueued while this sync tick's network-bound uploads are still
  // in flight) would do. Uploading the post-uploadInbox() value instead would
  // let the remote-visible nextCommandSeq claim a command whose file was
  // never actually part of this pass's upload loop -- and once Lua accepts a
  // forward move, its forward-only guard (2026-08-30) can never undo it.
  //
  // Break-verified: temporarily reading the snapshot AFTER uploadInbox()
  // instead of before reproduces the exact wrong value this test would then
  // catch (999 instead of 5) -- confirmed in the WSL gate run, reverted
  // before landing.
  it('uploads the queue-state snapshot captured before uploadInbox() runs, never a value that advanced during it', async () => {
    const transport = new PanelBridgeSftpTransport();
    transport.running = true;
    transport.config = validateSftpBridgeConfig(valid);
    transport.cachePath = makeTempCache();
    const statePath = path.join(transport.cachePath, '.queue-state-node.json');
    fs.writeFileSync(statePath, JSON.stringify({ nextCommandSeq: 5, lastConsumedResultSeq: 0 }));

    const put = vi.fn(async () => {});
    const rename = vi.fn(async () => {});
    transport.client = { exists: vi.fn(async () => false), put, rename, delete: vi.fn(async () => {}) };
    transport.ensureRemoteDirectories = vi.fn(async () => {});
    transport.syncModFile = vi.fn(async () => {});
    transport.syncOutbox = vi.fn(async () => {});
    // Simulates a second command being enqueued (and queue state persisted)
    // by the live panel process while this sync tick's uploadInbox() is
    // still working through its own (real, network-bound) per-file uploads.
    transport.uploadInbox = vi.fn(async () => {
      fs.writeFileSync(statePath, JSON.stringify({ nextCommandSeq: 999, lastConsumedResultSeq: 0 }));
    });

    await transport.syncNow();

    expect(put).toHaveBeenCalledTimes(1);
    const uploadedSource = put.mock.calls[0][0];
    expect(JSON.parse(uploadedSource.toString('utf8'))).toEqual({ nextCommandSeq: 5, lastConsumedResultSeq: 0 });
  });
});
