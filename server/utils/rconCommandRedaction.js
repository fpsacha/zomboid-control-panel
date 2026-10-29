/**
 * `adduser "<username>" "<password>"` is the RCON command PZ's own
 * whitelist-add flow sends (a real player join password, chosen by an
 * operator or the player themselves) -- and until this fix, database/init.js's
 * logCommand() persisted that string VERBATIM into command_history, and
 * GET /history returned it to any rcon.execute holder unredacted. Unlike
 * server/utils/serverRconSecrets.js's rconPassword (the PANEL's own
 * reconnection credential, deliberately relocated to a side-file so it can
 * be read back), a player's whitelist password embedded in a logged
 * command has no legitimate reason to ever be recovered from the audit
 * trail -- command_history exists to show WHAT was run, not to double as a
 * password store. So this redacts in place and discards the secret
 * entirely, at WRITE time: a read-time filter would leave the cleartext
 * sitting in db.json for anyone with file access, and db.json has already
 * been the subject of one credential-extraction finding.
 *
 * ENUMERATED before writing this (2026-08-27): every command in
 * server/utils/commands.js's PZ_COMMANDS -- the panel's own structured
 * mirror of PZ's full admin command set -- for a parameter that can hold a
 * credential. Exactly ONE: adduser's optional `password` (commands.js's
 * own adduser entry). No other command (banuser, setaccesslevel, teleport,
 * changeoption, ...) has a password/token/secret-shaped parameter.
 * changeoption's generic `newValue` string was considered and rejected as
 * a live risk: PZ's changeoption targets server config options (weather,
 * limits, messages), not credentials, and no seeded/real usage sets a
 * secret through it.
 *
 * Matches on the STRING SHAPE the command actually takes once built
 * (`adduser "user" "pass"`, both args double-quoted -- verified against
 * RconService.addUser, server/services/rcon.js:1349 and :1602, its two
 * call sites), not on which UI path produced it, so this also covers a
 * password typed directly into the /execute console, not just the
 * whitelist-add flow. sanitizeQuotedArg() (rcon.js) throws on any `"` or
 * `\` in either argument before the command string is even built, so
 * there is no embedded-quote/escaping case this regex needs to handle.
 * Case-insensitive on the command name: PZ's RCON accepts adduser
 * regardless of case, and an operator typing into /execute isn't
 * constrained to the panel's own lowercase convention.
 *
 * SECURITY (audit R1-8): that enumeration missed commands that
 * commands.js doesn't list, and the shape only matched both arguments quoted. The game
 * splits arguments with `([^"]\S*|".*?")\s*` (CommandBase), so
 * `adduser bob pw`, `adduser "bob" pw` and `adduser "bob"pw` all set a
 * password, and Discord /rcon strips every quote (rconService.sanitize())
 * before running a command. Now covered, quoted or not:
 *   - adduser <user> <password>
 *   - setpassword <user> <password> (SetPasswordCommand in the B42 jar)
 *   - changeoption Password|RCONPassword <value> (the join and RCON
 *     passwords, ChangeOptionCommand)
 * Only the secret argument is replaced; an unterminated quoted value is
 * hidden to the end of its line. Matching never crosses a line break, so
 * the log lines around a command are left as they are.
 */

// One argument as the game reads it: a quoted run, or a run of non-spaces.
// [^\S\r\n] is whitespace other than a line break.
const PASSWORD_COMMAND =
  /(\b(?:adduser|setpassword)[^\S\r\n]+(?:"[^"\r\n]*"[^\S\r\n]*|"?[^\s"]\S*[^\S\r\n]+))("[^"\r\n]*"?|\S+)/gi;
const SECRET_OPTION_COMMAND =
  /(\bchangeoption[^\S\r\n]+"?(?:RCON)?Password"?[^\S\r\n]+)("[^"\r\n]*"?|\S+)/gi;

export function redactRconCommandSecrets(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(PASSWORD_COMMAND, '$1"[REDACTED]"')
    .replace(SECRET_OPTION_COMMAND, '$1"[REDACTED]"');
}
