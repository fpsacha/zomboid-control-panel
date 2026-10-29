import { describe, expect, it } from "vitest";
import { redactRconCommandSecrets } from "../utils/rconCommandRedaction.js";

// bug-hunt-2026-08-27: command_history persisted `adduser "user" "pass"`
// verbatim -- a real player whitelist password, readable by anyone holding
// rcon.execute via GET /history, and sitting in cleartext on disk. Fixed at
// write time (database/init.js's logCommand), not read time. See
// rconCommandRedaction.js's own header for the full command-catalog
// enumeration this redactor is scoped to.

describe("redactRconCommandSecrets", () => {
  it("redacts the password argument from a two-arg adduser command", () => {
    expect(redactRconCommandSecrets('adduser "Bob" "hunter2"')).toBe(
      'adduser "Bob" "[REDACTED]"',
    );
  });

  it("is case-insensitive on the command name (a raw /execute console entry isn't constrained to lowercase)", () => {
    expect(redactRconCommandSecrets('ADDUSER "Bob" "hunter2"')).toBe(
      'ADDUSER "Bob" "[REDACTED]"',
    );
    expect(redactRconCommandSecrets('AddUser "Bob" "hunter2"')).toBe(
      'AddUser "Bob" "[REDACTED]"',
    );
  });

  it("leaves a one-arg adduser (no password, the Build 42 default) completely unchanged", () => {
    const noPassword = 'adduser "Bob"';
    expect(redactRconCommandSecrets(noPassword)).toBe(noPassword);
  });

  it("leaves every other command untouched, including ones with unrelated string args", () => {
    const untouched = [
      'kick "Bob" "griefing"',
      'setaccesslevel "Bob" "admin"',
      'banuser "Bob" "reason"',
      'servermsg "type adduser"', // contains the word but not the shape
      'changeoption "PVP" "true"',
      'changeoption "ServerWelcomeMessage" "Password reset tonight"',
      "changeoption PasswordHint x",
      "players",
      'teleport "Bob" "Alice"',
    ];
    for (const command of untouched) {
      expect(redactRconCommandSecrets(command)).toBe(command);
    }
  });

  it("redacts every adduser occurrence when more than one appears in the same string", () => {
    const two = 'adduser "Bob" "hunter2"; adduser "Alice" "correcthorse"';
    expect(redactRconCommandSecrets(two)).toBe(
      'adduser "Bob" "[REDACTED]"; adduser "Alice" "[REDACTED]"',
    );
  });

  it("passes non-string input through unchanged (response can legitimately be undefined/null)", () => {
    expect(redactRconCommandSecrets(undefined)).toBeUndefined();
    expect(redactRconCommandSecrets(null)).toBeNull();
  });

  it("redacts inside a response string too, in case a verbose RCON reply echoes the command it answered", () => {
    const echoed = 'Command received: adduser "Bob" "hunter2" -> User added';
    expect(redactRconCommandSecrets(echoed)).toBe(
      'Command received: adduser "Bob" "[REDACTED]" -> User added',
    );
  });
});

// SECURITY (audit R1-8): the game also takes unquoted arguments, Discord
// /rcon strips every quote before running a command, and setpassword and
// changeoption Password/RCONPassword carry passwords too.
describe("redactRconCommandSecrets: every form the game accepts", () => {
  const cases = [
    ['adduser "bob" hunter2', 'adduser "bob" "[REDACTED]"'],
    ['adduser bob "hunter2"', 'adduser bob "[REDACTED]"'],
    ["setpassword bob NewPass1", 'setpassword bob "[REDACTED]"'],
    ['setpassword "bob" "NewPass1"', 'setpassword "bob" "[REDACTED]"'],
    ['/setpassword "bob" "NewPass1"', '/setpassword "bob" "[REDACTED]"'],
    ["SetPassword bob NewPass1", 'SetPassword bob "[REDACTED]"'],
    ['changeoption "Password" "join-pw"', 'changeoption "Password" "[REDACTED]"'],
    ["changeoption RCONPassword rcon-pw", 'changeoption RCONPassword "[REDACTED]"'],
    // Discord /rcon runs `/rcon adduser "bob" "hunter2"` as this:
    ["adduser bob hunter2", 'adduser bob "[REDACTED]"'],
  ];
  for (const [input, expected] of cases) {
    it(`redacts ${input}`, () => {
      expect(redactRconCommandSecrets(input)).toBe(expected);
      expect(redactRconCommandSecrets(input)).not.toMatch(/hunter2|NewPass1|join-pw|rcon-pw/);
    });
  }

  it("keeps the text around the secret, on the same line and on the next ones", () => {
    expect(
      redactRconCommandSecrets(
        "Server rejected command: setpassword bob NewPass1 (User bob doesn't exist)\nnext line stays",
      ),
    ).toBe(
      "Server rejected command: setpassword bob \"[REDACTED]\" (User bob doesn't exist)\nnext line stays",
    );
    expect(redactRconCommandSecrets('adduser "bob"\nplayers')).toBe('adduser "bob"\nplayers');
  });

  it("is idempotent", () => {
    const once = redactRconCommandSecrets("adduser bob hunter2");
    expect(redactRconCommandSecrets(once)).toBe(once);
  });

  // Adversary pass: shapes the game still reads as user + password.
  it("redacts half-quoted, unterminated and spaceless forms", () => {
    const tricky = [
      'adduser "bob"hunter2', // a quoted argument needs no space after it
      'adduser "bob hunter2', // the game skips a quote that never closes
      'adduser bob "hunter2 and more', // unterminated: hidden to the end of the line
      "adduser\tbob\thunter2",
      "adduser   bob    hunter2",
      'ADDUSER "Bob Smith" hunter2',
    ];
    for (const input of tricky) {
      const out = redactRconCommandSecrets(input);
      expect(out).not.toContain("hunter2");
      expect(out).toContain("[REDACTED]");
    }
  });

  it("a broadcast that spells out the command shape has that word hidden: over-redaction, never a leak", () => {
    expect(redactRconCommandSecrets('servermsg "adduser is not a broadcast"')).toBe(
      'servermsg "adduser is "[REDACTED]" a broadcast"',
    );
  });
});
