import { describe, expect, it } from "vitest";
import { Readable } from "stream";
import { createServer, setSetting } from "../database/init.js";
import { writeUiSecretFile } from "../utils/uiSecretFile.js";
import {
  redactRawLogText,
  collectBundleKnownSecrets,
  createRedactingLogStream,
} from "../routes/debug.js";

// support-bundle-2026-08-30 follow-up (operator ruling): the four
// pre-existing raw-log categories (admin-panel, zomboid-server,
// zomboid-install, crash-logs) and the two added the same night
// (docker-container-logs.txt, managed-service-logs.txt) must ALL be
// redacted for known credential shapes -- uniformly, not a subset -- and
// the redaction must never be aggressive enough to eat the diagnostic
// content the bundle exists to preserve. See debug.js's redactRawLogText
// header for the two-layer design this file exercises.

// The exact line (Discord #bug_report, Rhazun) that made the
// Docker/systemd log capture feature worth building in the first place --
// see hive/agents/god/research/discord-restart-etxtbsy-2026-08-30.md. If a
// redaction rule ever touches this line, it has destroyed the one piece of
// evidence that made tonight's earlier fix possible.
const ETXTBSY_STACK_TRACE_LINE =
  "System.IO.IOException: Text file busy : '/project-zomboid/jre64/bin/java'";

describe("redactRawLogText() -- must never mangle ordinary diagnostic text", () => {
  it("leaves the exact ETXTBSY stack trace line that motivated this feature completely untouched", () => {
    expect(redactRawLogText(ETXTBSY_STACK_TRACE_LINE, [])).toBe(
      ETXTBSY_STACK_TRACE_LINE,
    );
    // Also survives with real known secrets loaded, not just an empty list.
    expect(
      redactRawLogText(ETXTBSY_STACK_TRACE_LINE, ["hunter2", "some-token-value"]),
    ).toBe(ETXTBSY_STACK_TRACE_LINE);
  });

  it("leaves an ordinary Java stack trace with file paths and quotes intact", () => {
    const line =
      'java.lang.RuntimeException: Failed to load "C:\\Servers\\pz\\Server\\test.ini" (exists=true)';
    expect(redactRawLogText(line, ["hunter2"])).toBe(line);
  });

  it("leaves plain unrelated log lines untouched", () => {
    const line = "[2026-08-30T12:00:00Z] INFO: Server started on port 16261";
    expect(redactRawLogText(line, [])).toBe(line);
  });
});

describe("redactRawLogText() -- known-secret-value exact match", () => {
  it("redacts an exact occurrence of a known RCON password", () => {
    const result = redactRawLogText(
      "RCON login attempt with password hunter2 rejected",
      ["hunter2"],
    );
    expect(result).toBe("RCON login attempt with password [REDACTED] rejected");
  });

  it("redacts every known secret independently in the same line", () => {
    const result = redactRawLogText(
      "rcon=alpha discord=beta sftp=gamma",
      ["alpha", "beta", "gamma"],
    );
    expect(result).toBe("rcon=[REDACTED] discord=[REDACTED] sftp=[REDACTED]");
  });

  it("is a no-op when no known secrets are supplied", () => {
    expect(redactRawLogText("nothing sensitive here", [])).toBe(
      "nothing sensitive here",
    );
  });
});

describe("redactRawLogText() -- shape-based patterns for what a known-value scrub structurally can't catch", () => {
  it("redacts the RCON adduser-with-password shape (a player's own whitelist password, never a stored 'known' secret)", () => {
    const line = 'executing: adduser "bob" "swordfish123"';
    const result = redactRawLogText(line, []);
    expect(result).toBe('executing: adduser "bob" "[REDACTED]"');
  });

  it("redacts a Discord-bot-token-shaped string even when it is not in the known-secrets list (e.g. a rotated token)", () => {
    // Deliberately low-entropy/repeated-character rather than random-looking:
    // an earlier version of this fixture used a first segment that legitimately
    // base64-decoded to an 18-digit number (a plausible Discord snowflake ID),
    // which is realistic enough that GitHub push protection blocked the commit
    // as a live Discord bot token (verified not real; see the commit history
    // for this file). GitHub's detector validates structure -- the first
    // segment decoding to a plausible snowflake -- not just the three-segment
    // dot shape, so this fixture is chosen to satisfy OUR shape regex (which
    // only checks charset/length/dot-count) while failing THAT check: 24
    // repeated 'x' bytes base64-decode to non-numeric garbage, never a
    // plausible snowflake. Confirmed still exercises the real code path --
    // this must keep failing if redactRawLogText's Discord-token branch is
    // ever removed or narrowed.
    const line =
      "Discord login failed for token xxxxxxxxxxxxxxxxxxxxxxxx.yyyyyy.zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    const result = redactRawLogText(line, []);
    expect(result).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxx.yyyyyy.zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");
    expect(result).toContain("[REDACTED-DISCORD-TOKEN]");
  });

  it("redacts the Steam Web API key out of a GetServerList request URL, keeping the rest of the URL readable", () => {
    const line =
      "fetch failed: https://api.steampowered.com/IGameServersService/GetServerList/v1/?key=0123456789abcdef0123456789abcdef&filter=\\appid\\108600&limit=10";
    const result = redactRawLogText(line, []);
    expect(result).not.toContain("0123456789abcdef0123456789abcdef");
    expect(result).toContain("?key=[REDACTED]");
    expect(result).toContain("GetServerList/v1/");
  });

  it("does not touch a bare alphanumeric string that merely happens to be long, outside a ?key=/&key= context", () => {
    const line = "session id: 0123456789abcdef0123456789abcdef (not a URL)";
    expect(redactRawLogText(line, [])).toBe(line);
  });

  // Security audit 2026-10-20: PZ (ServerWorldDatabase, first start of a
  // world) logs the -adminpassword value. Covered by shape too, for a value
  // the panel no longer holds (changed since, or a custom launcher's).
  it("redacts the game's 'Command line admin password:' line", () => {
    const line = "LOG  : General      f:0 st:195,165,107> Command line admin password: Sup3rS3cret! with spaces";
    expect(redactRawLogText(line, [])).toBe(
      "LOG  : General      f:0 st:195,165,107> Command line admin password: [REDACTED]",
    );
  });

  it("redacts only that line, keeping the next one and a CRLF ending", () => {
    const text = "Command line admin password: pw1\r\nRCON: listening on port 27015\r\n";
    expect(redactRawLogText(text, [])).toBe(
      "Command line admin password: [REDACTED]\r\nRCON: listening on port 27015\r\n",
    );
  });
});

describe("collectBundleKnownSecrets() -- assembles the real secret superset for this bundle", () => {
  it("includes a per-server RCON password, a Discord bot token, and a Steam API key together", async () => {
    await createServer({
      name: "RedactionTestServer",
      serverName: "RedactionTestServer",
      installPath: "/srv/pz",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "bundle-rcon-secret",
      serverPort: 16261,
    });
    writeUiSecretFile("discordBotToken", "bundle-discord-secret");
    await setSetting("steamApiKey", "bundle-steam-api-secret");

    const secrets = await collectBundleKnownSecrets();

    expect(secrets).toContain("bundle-rcon-secret");
    expect(secrets).toContain("bundle-discord-secret");
    expect(secrets).toContain("bundle-steam-api-secret");
  });

  // Security audit 2026-10-20: the game logs the -adminpassword value the
  // panel starts it with; the bundle's known secrets lacked it.
  it("includes every server profile's in-game admin password", async () => {
    await createServer({
      name: "AdminPwBundleServer",
      serverName: "AdminPwBundleServer",
      installPath: "/srv/pz",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      serverPort: 16261,
      adminPassword: "bundle-admin-secret",
    });

    expect(await collectBundleKnownSecrets()).toContain("bundle-admin-secret");
  });

  it("never throws when nothing is configured yet -- a fresh install must still produce a (empty) bundle", async () => {
    await expect(collectBundleKnownSecrets()).resolves.toEqual(
      expect.any(Array),
    );
  });
});

describe("createRedactingLogStream() -- streams a raw log file through the same redaction, without buffering it whole", () => {
  async function collectStream(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
  }

  it("redacts a known secret that arrives in a single chunk", async () => {
    const source = Readable.from(["password=hunter2 accepted\n"]);
    const out = await collectStream(source.pipe(createRedactingLogStream(["hunter2"])));
    expect(out).toBe("password=[REDACTED] accepted\n");
  });

  it("redacts a secret split across two chunk boundaries, since it buffers by line not by chunk", async () => {
    const source = Readable.from(["password=hunt", "er2 accepted\n"]);
    const out = await collectStream(source.pipe(createRedactingLogStream(["hunter2"])));
    expect(out).toBe("password=[REDACTED] accepted\n");
  });

  it("flushes a final line with no trailing newline", async () => {
    const source = Readable.from(["password=hunter2"]);
    const out = await collectStream(source.pipe(createRedactingLogStream(["hunter2"])));
    expect(out).toBe("password=[REDACTED]");
  });

  it("strips the admin password from the exact first-boot lines PZ writes, with no known secrets", async () => {
    const log = [
      "LOG  : General      f:0 st:195,165,107> User 'admin' not found, creating it ",
      "LOG  : General      f:0 st:195,165,107> Command line admin password: Sup3rS3cret!",
      "LOG  : General      f:0 st:195,166,001> RCON: listening on port 27015",
      "",
    ].join("\n");
    const out = await collectStream(Readable.from([Buffer.from(log)]).pipe(createRedactingLogStream([])));
    expect(out).not.toContain("Sup3rS3cret!");
    expect(out).toContain("Command line admin password: [REDACTED]");
    expect(out).toContain("RCON: listening on port 27015");
  });

  it("leaves the ETXTBSY stack trace line intact when streamed", async () => {
    const source = Readable.from([ETXTBSY_STACK_TRACE_LINE + "\n"]);
    const out = await collectStream(source.pipe(createRedactingLogStream(["hunter2"])));
    expect(out).toBe(ETXTBSY_STACK_TRACE_LINE + "\n");
  });
});

// SECURITY (audit R1-7): the game's admin log (Logs/<date>_admin.txt, in
// the bundle's zomboid-server/Logs) writes a whitelisted player's password
// in plain text (AddUserCommand), and the join or RCON password on a
// changeoption (ChangeOptionCommand). None of them is a value the panel holds.
describe("redactRawLogText() -- the game's admin log", () => {
  it("redacts the password from 'created user ... with password ...'", () => {
    expect(
      redactRawLogText("[28-10-26 13:00:00.123] admin created user bob with password hunter2 two.", []),
    ).toBe("[28-10-26 13:00:00.123] admin created user bob with password [REDACTED]");
  });

  it("redacts the join and RCON passwords from 'changed option'", () => {
    expect(redactRawLogText("[28-10-26 13:00:00.123] admin changed option Password=join pw", [])).toBe(
      "[28-10-26 13:00:00.123] admin changed option Password=[REDACTED]",
    );
    expect(redactRawLogText("[28-10-26 13:00:00.123] admin changed option RCONPassword=rc", [])).toBe(
      "[28-10-26 13:00:00.123] admin changed option RCONPassword=[REDACTED]",
    );
  });

  it("leaves the admin log's other lines as they are", () => {
    const lines = [
      "[28-10-26 13:00:00.123] admin created user bob without password",
      "[28-10-26 13:00:00.123] admin changed option PVP=true",
      "[28-10-26 13:00:00.123] admin changing password for the bob",
      "[28-10-26 13:00:00.123] bob said: I'll go with password reset tomorrow",
    ];
    for (const line of lines) expect(redactRawLogText(line, [])).toBe(line);
  });

  it("redacts only the line that carries the password", () => {
    const text = "admin created user bob with password pw1\r\nadmin created user amy without password\r\n";
    expect(redactRawLogText(text, [])).toBe(
      "admin created user bob with password [REDACTED]\r\nadmin created user amy without password\r\n",
    );
  });

  it("streams the rotated admin log through the same rule", async () => {
    const source = Readable.from([Buffer.from("x\nadmin created user bob with pass"), Buffer.from("word hunter2\n")]);
    const chunks = [];
    for await (const chunk of source.pipe(createRedactingLogStream([]))) chunks.push(Buffer.from(chunk));
    const out = Buffer.concat(chunks).toString("utf-8");
    expect(out).toBe("x\nadmin created user bob with password [REDACTED]\n");
  });

  // Adversary pass: a name that itself holds the marker words, and a line
  // made of the marker repeated (no quadratic rescan).
  it("still hides the password when the user name holds ' with password '", () => {
    const out = redactRawLogText("admin created user a with password b with password hunter2", []);
    expect(out).not.toContain("hunter2");
  });

  it("a line of repeated markers is redacted in linear time", () => {
    const line = " created user".repeat(40000) + " with password x".repeat(40000);
    const started = performance.now();
    const out = redactRawLogText(line, []);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out.endsWith(" with password [REDACTED]")).toBe(true);
  });
});

// SECURITY (audit R1-27): with -debug the game prints every RCON packet,
// the AUTH packet's body being the RCON password.
describe("redactRawLogText() -- the game's -debug RCON packet trace", () => {
  const SOCKET = "Socket[addr=/127.0.0.1,port=50123,localport=27015]";

  it("redacts the AUTH (Type=3) body and keeps the rest of the line", () => {
    expect(
      redactRawLogText(`LOG  : DetailedInfo f:0, t:1> RCON: ID=1 Type=3 Body='rotated pw' it's' ${SOCKET}`, []),
    ).toBe(`LOG  : DetailedInfo f:0, t:1> RCON: ID=1 Type=3 Body='[REDACTED]' ${SOCKET}`);
  });

  it("redacts the password inside a command body, keeping its closing quote", () => {
    expect(redactRawLogText(`RCON: ID=7 Type=2 Body='adduser bob hunter2' ${SOCKET}`, [])).toBe(
      `RCON: ID=7 Type=2 Body='adduser bob "[REDACTED]"' ${SOCKET}`,
    );
    expect(redactRawLogText(`RCON: ID=8 Type=2 Body='setpassword "bob" "pw"' ${SOCKET}`, [])).toBe(
      `RCON: ID=8 Type=2 Body='setpassword "bob" "[REDACTED]"' ${SOCKET}`,
    );
  });

  it("leaves an ordinary command body as it is", () => {
    const line = `RCON: ID=9 Type=2 Body='servermsg "hello"' ${SOCKET}`;
    expect(redactRawLogText(line, [])).toBe(line);
  });

  // Adversary pass: a password holding the "' Socket[" separator, and a
  // trace whose socket part is missing.
  it("hides an AUTH body that contains the separator or has no socket part", () => {
    expect(redactRawLogText(`RCON: ID=1 Type=3 Body='a' Socket[b' ${SOCKET}`, [])).toBe(
      `RCON: ID=1 Type=3 Body='[REDACTED]' ${SOCKET}`,
    );
    expect(redactRawLogText("RCON: ID=1 Type=3 Body='secret-without-socket", [])).toBe(
      "RCON: ID=1 Type=3 Body='[REDACTED]",
    );
    expect(redactRawLogText("RCON: ID=-1 Type=3 Body='pw'", [])).toBe("RCON: ID=-1 Type=3 Body='[REDACTED]'");
  });
});
