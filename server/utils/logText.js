// SECURITY (2026-10-05, H2): text a request chose, made safe to put in a
// log line. Moved here from routes/debug.js's client-error route (SDOS-3)
// so every log line that quotes a request header or unauthenticated input
// escapes it the same way.
//
// A CR/LF in such a value used to start a new line in combined.log -- the
// file support bundles ship -- that nobody could tell from a real panel
// entry. Node's HTTP parser refuses CR/LF in a header, but it accepts bytes
// 0x80-0xFF and hands them over as latin1, so 0x85 arrives as U+0085 (NEL),
// which some log viewers also break lines on, as they do on U+2028/U+2029.
// Every C0 control character, DEL, every C1 control character and
// U+2028/U+2029 is escaped to a visible \n / \r / \t / \uXXXX, so one value
// can never be more than its own part of one line.
// Built from code points: a literal U+2028/U+2029 in the source is invisible.
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const LOG_CONTROL_CHARS_RE = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${LINE_SEPARATORS}]`, "g");

// The characters a log viewer may break a line on that no message the panel
// writes itself contains: C1 control characters (NEL among them),
// U+2028/U+2029, and the vertical tab, form feed and file/group/record
// separators (Python's splitlines() breaks on those). utils/logger.js
// escapes these in every entry, whatever its source; CR/LF the panel's own
// messages and stack traces use, so indentLogContinuationLines handles them.
const LOG_LINE_BREAKERS_RE = new RegExp(`[\\x0b\\x0c\\x1c-\\x1e\\x80-\\x9f${LINE_SEPARATORS}]`, "g");
const LOG_LINE_BREAK_RE = /\r\n|\r|\n/g;
const LOG_CONTINUATION_INDENT = "    ";

function escapeChar(ch) {
  if (ch === "\n") return "\\n";
  if (ch === "\r") return "\\r";
  if (ch === "\t") return "\\t";
  return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/**
 * Escape request-supplied text for a log line. Anything that isn't a string
 * (an absent header, a number) is converted first; null/undefined become "".
 * @param {unknown} value
 * @returns {string}
 */
export function escapeLogText(value) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text.replace(LOG_CONTROL_CHARS_RE, escapeChar);
}

/**
 * Escape only the invisible line breakers (C1 controls, U+2028/U+2029) in a
 * finished log entry. See LOG_LINE_BREAKERS_RE.
 * @param {string} text
 * @returns {string}
 */
export function escapeLogLineBreakers(text) {
  return typeof text === "string" ? text.replace(LOG_LINE_BREAKERS_RE, escapeChar) : text;
}

/**
 * SECURITY (2026-10-28): keep a multi-line entry's line breaks (stack
 * traces, command output) but start every line after the first with
 * whitespace. A real entry's line starts with its timestamp, so text a
 * request chose (a backup name, a task id in a path) can no longer start a
 * line that reads as an entry of its own, at any call site. A line that
 * already starts with a space or tab, like a stack frame, is left as it is.
 * @param {string} text
 * @returns {string}
 */
export function indentLogContinuationLines(text) {
  if (typeof text !== "string") return text;
  return text.replace(LOG_LINE_BREAK_RE, (lineBreak, offset, whole) => {
    const next = whole.charAt(offset + lineBreak.length);
    return next === "" || next === " " || next === "\t" ? lineBreak : lineBreak + LOG_CONTINUATION_INDENT;
  });
}

/**
 * Everything utils/logger.js does to an entry's text before it is written
 * or streamed: escapeLogLineBreakers, then indentLogContinuationLines.
 * @param {string} text
 * @returns {string}
 */
export function formatLogEntryText(text) {
  return indentLogContinuationLines(escapeLogLineBreakers(text));
}
