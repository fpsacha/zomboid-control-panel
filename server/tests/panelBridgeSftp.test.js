import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// getSftpCachePath used to build its path from process.cwd() -- silently
// ignoring the operator's configured data directory, the same defect found
// in debug.js's crash-logs scan. Mocked here (the only export in this
// module that touches getDataPaths() at all -- confirmed by reading the
// source) rather than relying on the real, test-isolated data dir, so the
// "configured non-default dir" direction can be proven against a path that
// obviously isn't cwd and obviously isn't whatever default the test
// environment happens to be using this run.
// Default return value matters, not just for these tests: utils/logger.js
// (imported transitively via panelBridgeSftp.js) ALSO calls getDataPaths()
// once at module load time, before any test body runs -- an unconfigured
// vi.fn() (undefined) crashes that unrelated import with "Cannot read
// properties of undefined (reading 'logsDir')" the instant this file is
// collected. os.tmpdir() keeps that real (a real dir, just unused by
// anything below), so only the value getSftpCachePath actually reads is
// ever mocked away.
const mockDataPaths = vi.hoisted(() => {
  // process is a Node global, safe to use before any of this file's own
  // `import`s have run -- vi.hoisted callbacks execute above them. Plain
  // string concatenation, not path.join, for the same reason.
  const base = (process.env.TEMP || process.env.TMPDIR || '/tmp') + '/panel-bridge-sftp-test-default';
  const fn = () => ({ dataDir: base + '/data', logsDir: base + '/logs' });
  return { current: fn };
});
vi.mock('../utils/paths.js', () => ({ getDataPaths: (...args) => mockDataPaths.current(...args) }));

const { getSftpErrorGuidance, classifySftpErrorCode, PanelBridgeSftpTransport, validateSftpBridgeConfig, getSftpCachePath } =
  await import('../services/panelBridgeSftp.js');
const { ErrorCode } = await import('../utils/errorCodes.js');

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

describe('PanelBridge SFTP configuration', () => {
  it('accepts a constrained bridge configuration', () => {
    expect(validateSftpBridgeConfig(valid)).toMatchObject({
      host: 'pz.example.net',
      port: 22,
      pollIntervalSeconds: 3,
    });
  });

  it.each([1, 11])('rejects poll interval %s outside 2-10 seconds', (pollIntervalSeconds) => {
    expect(() => validateSftpBridgeConfig({ ...valid, pollIntervalSeconds })).toThrow('between 2 and 10 seconds');
  });

  it('does not replace an explicit zero port or poll interval with defaults', () => {
    expect(() => validateSftpBridgeConfig({ ...valid, port: 0 })).toThrow(
      'between 1 and 65535',
    );
    expect(() => validateSftpBridgeConfig({ ...valid, pollIntervalSeconds: 0 })).toThrow(
      'between 2 and 10 seconds',
    );
  });

  it('rejects remote path traversal', () => {
    expect(() => validateSftpBridgeConfig({ ...valid, bridgePath: '/home/pz/../etc' })).toThrow('without traversal');
  });

  it('rejects the filesystem root as a bridge folder', () => {
    expect(() => validateSftpBridgeConfig({ ...valid, bridgePath: '/' })).toThrow('not the filesystem root');
  });

  it('rejects control characters in a remote bridge path', () => {
    expect(() => validateSftpBridgeConfig({ ...valid, bridgePath: '/home/pz\nbridge' })).toThrow('absolute POSIX path');
  });

  it('provides a credential fix for SSH public-key authentication errors', () => {
    expect(getSftpErrorGuidance(new Error('Permission denied (publickey).'))).toMatch(/username and password/i);
  });

  it('explains chroot paths when mkdir is denied under home', () => {
    expect(getSftpErrorGuidance(new Error('mkdir: _doMkdir: Permission denied /Home'))).toMatch(/remove the \/home prefix/i);
  });

  it('keeps chroot guidance when the transport classifies the path failure', () => {
    expect(getSftpErrorGuidance(new Error('SFTP account rejected remote bridge path /home/server-data; likely chrooted account path'))).toMatch(/remove the \/home prefix/i);
  });

  it('explains how to repair a non-regular bridge file path', () => {
    expect(getSftpErrorGuidance(new Error('Expected a regular file, but found a non-regular entry'))).toMatch(/remove or rename/i);
  });
});

// 2026-08-26: formatSftpError()/getSftpErrorGuidance() classified these
// failures correctly but only ever produced English text -- these codes are
// what let a route response carry the SAME classification as a translatable
// `code` + `params.detail`, per code registered+translated in errors.json
// (all six locales). One test per branch, in the SAME order
// classifySftpError()'s list checks them, so a reordering that changes which
// pattern wins on an ambiguous message is caught here.
describe('classifySftpErrorCode: mirrors getSftpErrorGuidance\'s classification as a stable code', () => {
  it('SFTP_CHROOTED_ACCOUNT for a chrooted mkdir failure under /home', () => {
    expect(classifySftpErrorCode(new Error('mkdir: _doMkdir: Permission denied /Home'))).toBe(
      ErrorCode.SFTP_CHROOTED_ACCOUNT,
    );
  });

  it('SFTP_AUTH_FAILED for a public-key authentication failure', () => {
    expect(classifySftpErrorCode(new Error('Permission denied (publickey).'))).toBe(
      ErrorCode.SFTP_AUTH_FAILED,
    );
  });

  it('SFTP_PERMISSION_DENIED for a plain permission-denied write failure', () => {
    expect(classifySftpErrorCode(new Error('Failure: mkdir /home/pz/bridge: Permission denied'))).toBe(
      ErrorCode.SFTP_PERMISSION_DENIED,
    );
  });

  it('SFTP_REMOTE_PATH_MISSING when the remote bridge folder does not exist', () => {
    expect(classifySftpErrorCode(new Error('No such file'))).toBe(ErrorCode.SFTP_REMOTE_PATH_MISSING);
  });

  it('SFTP_PATH_OCCUPIED when a directory occupies the bridge file path', () => {
    expect(classifySftpErrorCode(new Error('Expected a regular file, but found a non-regular entry'))).toBe(
      ErrorCode.SFTP_PATH_OCCUPIED,
    );
  });

  it('SFTP_UNREACHABLE for a connection-level failure', () => {
    expect(classifySftpErrorCode(new Error('connect ECONNREFUSED 10.0.0.5:22'))).toBe(
      ErrorCode.SFTP_UNREACHABLE,
    );
  });

  it('SFTP_UNKNOWN as the catch-all for an unrecognized failure', () => {
    expect(classifySftpErrorCode(new Error('something completely unexpected happened'))).toBe(
      ErrorCode.SFTP_UNKNOWN,
    );
  });

  it('every code classifySftpErrorCode can return is registered in errorCodes.js', () => {
    const messages = [
      'mkdir: _doMkdir: Permission denied /Home',
      'Permission denied (publickey).',
      'Failure: mkdir /home/pz/bridge: Permission denied',
      'No such file',
      'Expected a regular file, but found a non-regular entry',
      'connect ECONNREFUSED 10.0.0.5:22',
      'something completely unexpected happened',
    ];
    for (const message of messages) {
      const code = classifySftpErrorCode(new Error(message));
      expect(typeof code).toBe('string');
      expect(Object.values(ErrorCode)).toContain(code);
    }
  });
});

describe('getSftpCachePath: follows the configured data directory, not process.cwd()', () => {
  const defaultDataPaths = mockDataPaths.current;

  afterEach(() => {
    mockDataPaths.current = defaultDataPaths;
  });

  it('a configured non-default data dir is honoured', () => {
    const configuredRoot = path.join('T:', 'operator-configured-root', 'data');
    mockDataPaths.current = () => ({ dataDir: configuredRoot, logsDir: path.join('T:', 'operator-configured-root', 'logs') });

    const cachePath = getSftpCachePath(valid);

    expect(cachePath.startsWith(path.join(configuredRoot, 'panelbridge-sftp-cache'))).toBe(true);
    expect(cachePath.startsWith(process.cwd())).toBe(false);
  });

  it('a different configured data dir produces a different cache path for the same bridge config', () => {
    mockDataPaths.current = () => ({ dataDir: path.join('T:', 'root-a', 'data') });
    const a = getSftpCachePath(valid);
    mockDataPaths.current = () => ({ dataDir: path.join('T:', 'root-b', 'data') });
    const b = getSftpCachePath(valid);

    expect(a).not.toBe(b);
    expect(a.startsWith(path.join('T:', 'root-a', 'data'))).toBe(true);
    expect(b.startsWith(path.join('T:', 'root-b', 'data'))).toBe(true);
  });

  it('the cache key is stable for the same config and changes when the config changes -- proven independently of which data dir is configured', () => {
    mockDataPaths.current = () => ({ dataDir: path.join('T:', 'operator-configured-root', 'data') });

    const a = getSftpCachePath(valid);
    const b = getSftpCachePath(valid);
    const c = getSftpCachePath({ ...valid, host: 'different.example.net' });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('the real (unmocked) default paths.js resolution still works', async () => {
    const real = await vi.importActual('../utils/paths.js');
    mockDataPaths.current = real.getDataPaths;

    const cachePath = getSftpCachePath(valid);

    expect(cachePath.startsWith(path.join(real.getDataPaths().dataDir, 'panelbridge-sftp-cache'))).toBe(true);
  });
});

describe('PanelBridge SFTP sync', () => {
  it('creates the remote bridge, inbox, and outbox folders before syncing', async () => {
    const transport = new PanelBridgeSftpTransport();
    const mkdir = vi.fn();
    transport.config = validateSftpBridgeConfig(valid);
    transport.client = { mkdir };

    await transport.ensureRemoteDirectories();

    expect(mkdir).toHaveBeenNthCalledWith(1, valid.bridgePath, true);
    expect(mkdir).toHaveBeenNthCalledWith(2, `${valid.bridgePath}/inbox`, true);
    expect(mkdir).toHaveBeenNthCalledWith(3, `${valid.bridgePath}/outbox`, true);
  });

  it('classifies permission errors under /home as a chroot path problem', async () => {
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.client = { mkdir: vi.fn(async () => { throw new Error('Permission denied /home'); }) };

    await expect(transport.ensureRemoteDirectories()).rejects.toThrow(/chrooted account path/);
  });

  it('exposes bounded diagnostics without retaining the SFTP password', () => {
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);

    for (let index = 0; index < 21; index += 1) {
      transport.recordError('sync', new Error(`failure-${index}`));
    }

    const status = transport.getStatus();
    expect(status.diagnostics.failureCount).toBe(21);
    expect(status.diagnostics.recentErrors).toHaveLength(20);
    expect(status.diagnostics.recentErrors[0].message).toBe('failure-1');
    expect(JSON.stringify(status)).not.toContain(valid.password);
  });

  // sweep-round5 (2026-09-07): cachePath (local host path) and
  // remotePath/remoteDirectories (the REMOTE server's filesystem paths)
  // used to be unconditionally returned here, and were never read anywhere
  // in client/src -- grepped before removing, not assumed. "Removing beats
  // gating": a field absent from the response has nothing for a future
  // debug log, support bundle, or screenshot to leak, and cannot be
  // silently widened back open the way a gate can. This is the regression
  // guard for that removal, not a new capability test (GET
  // /panel-bridge/status's own permission gate is covered separately, in
  // server/routes/panelBridge.js's route definition).
  it('does not expose cachePath, remotePath, or remoteDirectories -- host and remote filesystem paths nothing client-side reads', () => {
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.cachePath = '/some/local/cache/path';

    const status = transport.getStatus();

    expect(status).not.toHaveProperty('cachePath');
    expect(status).not.toHaveProperty('remotePath');
    expect(status).not.toHaveProperty('remoteDirectories');
    // The instance property itself is untouched -- only the outward-facing
    // getStatus() response changed. Real internal uses of this.cachePath
    // (opening/writing the local cache) are unaffected.
    expect(transport.cachePath).toBe('/some/local/cache/path');
  });

  it('uploads queued commands before downloading remote Bridge files', async () => {
    const transport = new PanelBridgeSftpTransport();
    const order = [];
    transport.running = true;
    transport.ensureRemoteDirectories = vi.fn(async () => order.push('directories'));
    transport.uploadInbox = vi.fn(async () => order.push('upload'));
    transport.syncModFile = vi.fn(async (name) => order.push(name));
    transport.syncOutbox = vi.fn(async () => order.push('outbox'));

    await transport.syncNow();

    expect(order).toEqual(['directories', 'upload', 'status.json', 'queue-state-lua.json', 'outbox']);
  });

  it('uploads commands to a temporary remote name before publishing them', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-sftp-test-'));
    temporaryDirectories.push(temporaryDirectory);
    const inboxDirectory = path.join(temporaryDirectory, 'inbox');
    fs.mkdirSync(inboxDirectory);
    fs.writeFileSync(path.join(inboxDirectory, 'cmd-0000000001.json'), '{"action":"ping"}');

    const fastPut = vi.fn(async () => {});
    const rename = vi.fn(async () => {});
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.cachePath = temporaryDirectory;
    transport.transferId = 'test-transfer';
    transport.client = { exists: vi.fn(async () => false), fastPut, rename, delete: vi.fn(async () => {}) };

    await transport.uploadInbox();

    const remotePath = `${valid.bridgePath}/inbox/cmd-0000000001.json`;
    expect(fastPut).toHaveBeenCalledWith(
      path.join(inboxDirectory, 'cmd-0000000001.json'),
      `${remotePath}.test-transfer.uploading`,
    );
    expect(rename).toHaveBeenCalledWith(`${remotePath}.test-transfer.uploading`, remotePath);
  });

  it('removes a partial remote command when an upload fails', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-sftp-test-'));
    temporaryDirectories.push(temporaryDirectory);
    const inboxDirectory = path.join(temporaryDirectory, 'inbox');
    fs.mkdirSync(inboxDirectory);
    fs.writeFileSync(path.join(inboxDirectory, 'cmd-0000000001.json'), '{"action":"ping"}');

    const deleteRemote = vi.fn(async () => {});
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.cachePath = temporaryDirectory;
    transport.transferId = 'failed-transfer';
    transport.client = {
      exists: vi.fn(async () => false),
      fastPut: vi.fn(async () => { throw new Error('Connection reset'); }),
      rename: vi.fn(async () => {}),
      delete: deleteRemote,
    };

    await expect(transport.uploadInbox()).rejects.toThrow('Connection reset');
    expect(deleteRemote).toHaveBeenCalledWith(
      `${valid.bridgePath}/inbox/cmd-0000000001.json.failed-transfer.uploading`,
    );
  });

  it('refuses to treat a remote directory as an already uploaded command', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-sftp-test-'));
    temporaryDirectories.push(temporaryDirectory);
    const inboxDirectory = path.join(temporaryDirectory, 'inbox');
    fs.mkdirSync(inboxDirectory);
    fs.writeFileSync(path.join(inboxDirectory, 'cmd-0000000001.json'), '{"action":"ping"}');

    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.cachePath = temporaryDirectory;
    transport.client = { exists: vi.fn(async () => 'd') };

    await expect(transport.uploadInbox()).rejects.toThrow('occupied by a directory');
  });

  it('refuses symlinks and oversized remote bridge files', async () => {
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.cachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-sftp-test-'));
    temporaryDirectories.push(transport.cachePath);
    const fastGet = vi.fn();
    transport.client = { exists: vi.fn(async () => 'l'), stat: vi.fn(), fastGet };

    await expect(transport.copyRemote('status.json.txt')).rejects.toThrow('non-regular entry');
    expect(fastGet).not.toHaveBeenCalled();

    transport.client = {
      exists: vi.fn(async () => '-'),
      stat: vi.fn(async () => ({ size: 16 * 1024 * 1024 + 1 })),
      fastGet,
    };
    await expect(transport.copyRemote('status.json.txt')).rejects.toThrow('download limit');
    expect(fastGet).not.toHaveBeenCalled();
  });
});
