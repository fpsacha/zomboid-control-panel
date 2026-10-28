import { redactRconCommandSecrets } from "./rconCommandRedaction.js";

// Secrets the game itself writes to its console log (server-console.txt).
//
// SECURITY (2026-10-20): on a world's first start the game creates the
// "admin" account from the -adminpassword the panel passes it
// (routes/server.js) and logs the value in plain text, from
// zombie.network.ServerWorldDatabase:
//   LOG  : General      f:0 st:...> Command line admin password: <password>
// The support bundle copied that line as written, and the Console page
// showed it to every role with server.world_events (moderators included).
// No one needs to read it there, so it is redacted for every role.
// The panel refuses an admin password with a control character
// (services/startScriptValues.js), so the value never runs past the line.
const COMMAND_LINE_ADMIN_PASSWORD = /(Command line admin password:)[^\r\n]*/gi;

// SECURITY (audit R1-7): the game's "admin" log (Logs/<date>_admin.txt, in
// the support bundle) records who changed what, passwords included, from
// AddUserCommand and ChangeOptionCommand in the B42 jar:
//   <executor> created user <user> with password <password>
//   <executor> changed option Password=<join password>
//   <executor> changed option RCONPassword=<RCON password>
// The value is the rest of the line. A whitelisted player's own password is
// never a value the panel holds, so only its shape can catch it.
const CREATED_USER_PASSWORD = / with password [^\r\n]*/g;
const CHANGED_SECRET_OPTION = /( changed option (?:RCON)?Password=)[^\r\n]*/gi;

// SECURITY (audit R1-27): with -debug (Server Setup's Debug toggle) the game
// prints every RCON packet it receives, from RCONServer$ClientThread:
//   RCON: ID=<id> Type=<type> Body='<body>' Socket[addr=...]
// The body of a Type=3 (AUTH) packet is the RCON password, sent on every
// connect; a Type=2 body is the command, e.g. adduser with a password.
const RCON_PACKET_TRACE = /(RCON: ID=-?\d+ Type=(-?\d+) Body=')([^\r\n]*)/g;

function lineBefore(text, offset) {
  const start = Math.max(text.lastIndexOf("\n", offset), text.lastIndexOf("\r", offset)) + 1;
  return text.slice(start, offset);
}

// The body ends at the last "' Socket[" on the line, or at a closing quote
// at the end of the line; without either, the whole rest of the line is
// treated as the body.
function splitPacketBody(rest) {
  let end = rest.lastIndexOf("' Socket[");
  if (end < 0) {
    const closing = /'\s*$/.exec(rest);
    end = closing ? closing.index : -1;
  }
  return end < 0 ? [rest, ""] : [rest.slice(0, end), rest.slice(end)];
}

export function redactGameLogSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(COMMAND_LINE_ADMIN_PASSWORD, "$1 [REDACTED]")
    .replace(CREATED_USER_PASSWORD, (match, offset, whole) =>
      lineBefore(whole, offset).includes(" created user ")
        ? " with password [REDACTED]"
        : match,
    )
    .replace(CHANGED_SECRET_OPTION, "$1[REDACTED]")
    .replace(RCON_PACKET_TRACE, (match, head, type, rest) => {
      const [body, tail] = splitPacketBody(rest);
      const safeBody = type === "3" ? "[REDACTED]" : redactRconCommandSecrets(body);
      return head + safeBody + tail;
    });
}
