// Extra JVM arguments for a server's generated start script (GH #303):
// a Java agent such as ZombieBuddy (-javaagent:ZombieBuddy.jar), or any
// other -D/-XX option the panel doesn't set itself.
//
// They go into the .bat and the .sh unquoted, so every token is held to a
// character set neither cmd.exe nor bash gives a meaning to: no quotes,
// spaces inside a token, %, $, `, !, ^, &, |, ;, <, >, ( or ). A -javaagent
// runs code at the next start, so changing them takes files.manage, like a
// custom start command (routes/servers.js changesLaunchTarget()).

export const EXTRA_JVM_ARGS_MAX_LENGTH = 1024;

// Starts with "-", then letters, digits and _ . : = + , / \ @ -
const TOKEN = /^-[A-Za-z0-9_.:=+,/\\@-]+$/;

// { ok: true, args: string[] } or { ok: false, token }: the first token
// that isn't allowed ("" when the whole value is wrong: not a string, too
// long).
export function parseExtraJvmArgs(value) {
  if (value === undefined || value === null) return { ok: true, args: [] };
  if (typeof value !== "string" || value.length > EXTRA_JVM_ARGS_MAX_LENGTH) {
    return { ok: false, token: "" };
  }
  const args = value.split(/[ \t]+/).filter(Boolean);
  if (/[\r\n]/.test(value)) return { ok: false, token: "" };
  for (const token of args) {
    if (!TOKEN.test(token)) return { ok: false, token: token.slice(0, 80) };
  }
  return { ok: true, args };
}
