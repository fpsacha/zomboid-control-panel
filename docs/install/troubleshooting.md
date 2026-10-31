# Troubleshooting

The other guides in this folder tell you what to do. This one is for when
that didn't work.

Part 1 is a checklist to run through **before** you start any install —
having these five things ready up front avoids most of the trouble in Part
2. Part 2 is organized by what you actually **see on screen**: find the
heading that matches your symptom, not the subsystem you think is at fault.
Every heading below quotes real on-screen text — search this page (Ctrl+F)
for a phrase you're looking at and you'll land in the right place.

Several sections below tell you to check the panel's log. If the default log
isn't detailed enough to see what's actually happening, set
`LOG_LEVEL=debug` (in a `.env` file next to the panel `.exe`, in your
`docker-compose.yml`/`.env`, or in the service's environment on Linux) and
restart the panel — this applies everywhere a section below says to check
the log, not just one symptom.

---

## Part 1: Preflight — have these five things ready

Gather these *before* you open the panel for the first time. All five come
from the PZ server `.ini` you're pointing the panel at, or from your own
network — the panel can't discover them for you.

1. **RCON port and password** — from the PZ server's `.ini`:
   ```ini
   RCONPort=27015
   RCONPassword=choose-a-strong-password
   ```
   If the `.ini` doesn't have a password set yet, set one now and restart
   the PZ server before continuing — the panel needs both values to connect
   at all.

2. **The PZ server's install path** — the folder containing the server's
   `.ini`, `ProjectZomboid64` (or `.exe`), and its `Zomboid/` save data (or
   the separate paths for each, if you keep them apart). You'll type this
   into **Settings** or the Setup Wizard.

3. **The Zomboid data path** — where saves, logs, and server config actually
   live (`~/Zomboid` on Linux/macOS, `%USERPROFILE%\Zomboid` on Windows,
   unless you've relocated it with `-Zomboid=...` or `ZomboidINI`).

4. **A free port for the panel** — 3001 by default. If something else on
   the host already uses it, see
   [Panel will not start / port in use](#panel-will-not-start--port-in-use)
   below before you're surprised by it.

5. **`DoLuaChecksum=false`** in the PZ server `.ini` — only if you want
   PanelBridge (teleport, heal, god mode, weather control, and the other
   RCON-can't-reach features). It depends on how PanelBridge is installed,
   which you choose later in **Settings → PanelBridge → How PanelBridge is
   installed**:
   - **Installed by the panel** (the default): it must be `false`, or
     players can't join.
   - **Steam Workshop** (Build 42 servers running with Steam): leave it
     `false` until that page confirms PanelBridge loaded from the Workshop.
     After that you can turn it back on.

   Skip this if you don't plan to use PanelBridge.

If you're installing through Docker and the panel will also read or write
PZ's own files (config editing, local backups, PanelBridge without SFTP),
also note the **numeric UID/GID that owns your PZ folders** (`id -u` /
`id -g` on the host) — you'll need it for `PUID`/`PGID` in `.env`. See
[Permission denied on mounted PZ folders](#permission-denied-on-mounted-pz-folders)
if you skip this and hit trouble.

---

## Part 2: Symptom-first troubleshooting

### Panel will not start / port in use

**What you see:** the panel process exits, or `docker logs` / the console
shows something like `Port 3001 is in use and PORT is explicitly set;
refusing to choose a different port.`

**What it means:** the panel tried to bind its HTTP port and something else
already had it. If you never set a `PORT` environment variable yourself, the
panel already tried a short retry-and-backoff sequence and then picked a
free port automatically — you'd see `Port 3001 remained unavailable after
... retries; selecting a free port automatically.` in the log, and the panel
is actually running, just not on 3001. Check the log for which port it
picked. If you **did** set `PORT` explicitly (an env var, `.env`, or a
Docker Compose mapping), the panel refuses to silently choose a different
one instead of binding somewhere you didn't expect — that's the case above.

**What to do:** find whatever is holding the port:
- Windows: `netstat -ano | findstr :3001`
- Linux/macOS: `ss -tlnp | grep :3001` (or `lsof -i :3001`)

Stop that process, or change `PORT` (bare-metal) / the left-hand side of the
port mapping in `docker-compose.yml` (Docker) to a free port, then restart.

The same message and the same fix apply to `HTTPS port ... is already in
use` if you've enabled `HTTPS=true`.

---

### Panel opens a new browser tab every time it starts or restarts

**What you see:** every time the panel (the Windows/macOS/Linux `.exe`
install, not Docker) starts up, it opens a new tab pointed at the panel's
login page — including on a restart, so if something is restarting the panel
repeatedly you end up with a pile of tabs to close by hand.

**What it means:** this is by design for a fresh, interactive install — the
first time you start the panel, it opens a tab automatically so you don't
have to know the URL and type it in yourself. It fires on *every* process
start, not just the first one, because the panel has no way to tell "first
run" apart from "restart #40" — it only knows it's starting. If the panel is
restarting more often than you expect, that's worth chasing down separately
(see below); the tab-per-start behavior itself is expected, not a bug, and
can be turned off.

**What to do:** set `PANEL_AUTO_OPEN_BROWSER=false` in a `.env` file in the
same folder as the panel `.exe` (create the file if it doesn't exist; it's
read automatically on every start), then restart the panel. Any of `0`,
`false`, `no`, or `off` works. This is the right setting for a headless box,
a server you control over RDP/SSH rather than sitting at, or any machine
where you'd rather keep one browser tab open yourself than have the panel
manage tabs for you.

**If the panel is restarting on its own and you don't know why:** the panel
itself has no built-in "restart periodically to free memory" feature —
nothing in its code restarts the panel process on a timer or a memory
threshold. If it's restarting anyway, something external is doing it: a
Task Scheduler entry, a service manager set to auto-restart on exit, an
update being applied (Settings > Updates restarts the panel to apply a
downloaded version), or a crash. Check `log.jsonl` in the panel's data
folder for `app-start` entries — repeated `app-start` events close together
in time, especially right after an error, point to a crash loop rather than
an intentional restart, and are worth reporting rather than just muting the
tab.

---

### Cannot log in / forgot the admin password

**What you see:** `Invalid username or password` even though you're sure
the password is right, or you simply never wrote it down.

**What it means, first:** if a password has been mistyped 10 times for an
account from one address, sign-ins to that account from that address pause
for 15 minutes. Other addresses are not affected, and SSO sign-in is never
paused by wrong passwords. A browser that has signed in to that account
before (by password, first-run setup, or SSO) is counted on its own instead
of by address: ten wrong passwords typed in that browser pause that browser,
and nothing typed anywhere else pauses it. The browser keeps this as a small
token in its site storage, one per username; a private window, cleared site
data or a different browser starts over as a new browser. Changing or
resetting the password, or regenerating the JWT signing key, makes every
browser new again until it signs in once — except the browser you did it
from, which is handed a fresh token straight away. The Steam Sync browser
extension keeps one the same way. The panel still shows the exact same
`Invalid username or password` message during the pause, not a distinct
"account locked" message (this is deliberate: a message that changed when a
pause started would let someone confirm an account exists just by trying
wrong passwords against it). If you were sure of the password and it
suddenly stops working for a while after several attempts, this is almost
certainly why. Wait 15 minutes and try again with the correct password
before assuming it's actually wrong — or reset it with one of the recovery
paths below, which also lifts every pause on the account.

For a browser that hasn't signed in before, the pause is per address, so
it only keeps strangers' guesses apart from you if the panel sees each
visitor's real address. Behind a reverse proxy or tunnel (nginx, Caddy,
cloudflared) every request arrives from the proxy's own address unless
`TRUST_PROXY` is set (see [Linux](linux.md) and the Remote Access notes in
the README), and inside Docker, IPv6 visitors can all arrive from the bridge
gateway. In that setup everyone shares one address, so ten wrong passwords
from anyone pause the account for every browser that hasn't signed in
before, and the per-minute limit below is shared too. A browser you have
already signed in with is counted on its own for both, so wrong passwords
from that address don't stop it. Everything else stays shared by address,
though: the panel's general limit of 300 requests a minute, and the limit of
3 tries per 15 minutes on reset tokens and recovery codes. Someone flooding
that address with requests can still hold everyone at it up, a browser you
signed in with included (`--reset-password` on the host always works). Set
`TRUST_PROXY` when the panel is only reachable through your proxy, so
visitors are told apart again.

After a few failed sign-in attempts from the same browser, the login page
itself starts showing a **"Still not working?"** hint explaining this same
15-minute pause and pointing at recovery codes and `--reset-password` —
it appears the same way regardless of whether the account you're typing
exists, is paused, or the password was simply wrong, so seeing it isn't
itself a sign anything is broken.

Also check for `Too many login attempts. Please try again later.` — that's
a separate, shorter limit (5 attempts per minute per IP, or per browser for
one that has signed in before) and clears in under a minute.

**If you actually don't know the password**, the panel has three recovery
paths, in order of convenience:

1. **A recovery code** — if you generated single-use recovery codes in
   advance (**Settings → Security**), use one on the login screen's "Recover
   account" flow. Each code works once, and resets the password of the admin
   who generated it, while that account is still an admin. Codes made by a
   panel older than this rule no longer work: generate new ones.
2. **A local recovery token** — only works when you open the panel directly
   on the machine it's running on (loopback or one of the host's own IPs).
   The login screen's recovery flow creates `data/reset-token.txt` on the
   host; open that file, paste the token back into the browser. If it
   instead explains how to create the file yourself, the panel couldn't
   confirm the request came from the host itself — see the two cases below.
3. **The `--reset-password` CLI flag** — run the panel binary/start script
   with `--reset-password` from a terminal on the host itself. This is
   interactive: it lists existing users and asks for a new password.

**If you're behind a reverse proxy** (nginx, Caddy, a VPS setup) and the
recovery screen says `This panel is running behind a reverse proxy, so it
can't verify a request came from the server itself. Create
data/reset-token.txt on the host directly, or use a recovery code instead.`
— the local-token flow can't confirm your browser request truly originated
on the host once a proxy sits in front of it. The panel also answers this
way, and logs once that `TRUST_PROXY` looks missing, when `TRUST_PROXY` isn't
set but the request carries a proxy's headers (`X-Forwarded-For`,
`Forwarded`, `X-Real-IP` and the like). A proxy that adds none of them, such
as a bare nginx `proxy_pass`, still looks like the host itself, so set
`TRUST_PROXY` whenever a proxy or tunnel runs on the same machine. Either create
`data/reset-token.txt` yourself directly on the host and then choose
**Enter a recovery token** on the login screen (or switch the recovery form
to **Recovery token**) — or use a recovery code, or run `--reset-password`
on the host instead.

The token has to be one nobody can guess: random hex (only `0-9` and
`a-f`, in either case), at least 32 hex digits, made by a generator rather
than typed by you. Run one of these from the panel's folder. Each writes a
file the panel reads as it is: a line break at the end, Windows line
breaks, a byte order mark, and the UTF-16 that Windows PowerShell's `>`
writes are all fine.

On Linux or macOS:

```sh
openssl rand -hex 24 > data/reset-token.txt
```

Without openssl, `uuidgen > data/reset-token.txt` or
`head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > data/reset-token.txt`
work too.

If the panel runs as a Linux service (see [Linux](linux.md)), its `data`
folder belongs to the service account and nobody else can write in it, so
the line above fails with `Permission denied`. Write the file as that
account instead (`pzuser` and `/opt/zomboid-panel` in the standard
install):

```sh
sudo -u pzuser sh -c 'openssl rand -hex 24 > /opt/zomboid-panel/data/reset-token.txt'
```

In PowerShell on Windows (Windows PowerShell 5.1 or PowerShell 7):

```powershell
$b = [byte[]]::new(24); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') }) | Set-Content -Encoding ascii data\reset-token.txt
```

or a UUID:

```powershell
(New-Guid).Guid | Set-Content -Encoding ascii data\reset-token.txt
```

If openssl is installed (Git for Windows ships one),
`openssl rand -hex 24 > data\reset-token.txt` works in PowerShell too. From
`cmd.exe`, type `powershell` first, then one of the lines above.

With Docker, from the host (the supplied compose files name the container
`zomboid-panel`):

```sh
docker exec zomboid-panel node -e "require('fs').writeFileSync('/app/data/reset-token.txt', require('crypto').randomBytes(24).toString('hex'))"
```

Now and then random output happens to look like a pattern or like text
and is refused: about 1 in 13,000 32-digit tokens or 1 in 15,000 UUIDs,
and hardly ever 48 digits (`openssl rand -hex 24` and the first PowerShell
line). If that happens, run the command again.

**Don't use `echo $RANDOM | md5sum` or `date | md5sum`** (or `sha256sum`),
or anything else built on bash's `$RANDOM`, cmd's `%RANDOM%` or the time:
`$RANDOM` is one of only 32,768 numbers, and the time to the second one of
86,400 a day, so anyone can work out every token they can make. The panel
refuses the usual `$RANDOM` hashes, but don't count on it to catch every
variation, and it can't tell a hash of the time from random hex at all.
The same goes for hashing a word: the panel refuses hashes of the obvious
words, but it can't know every word you might pick.

The panel refuses the common mistakes: words, a sentence or a phrase
(`zomboid-control-panel-reset-token`), a number on its own (the digits of
pi, a date), hex words (`deadbeefcafe…`), repeated or sequential characters
(`aaaa`, `abcd`, `4321`), keyboard patterns (`qwerty`, `1qaz2wsx`), the same
stretch repeated, or runs interleaved (`a1b2c3`); text written as hex in
the usual encodings (a phrase run through `xxd -p`, Python's `.hex()`,
PowerShell's `[Convert]::ToHexString` or an online text-to-hex converter);
hashes of `$RANDOM` or of common words; and UUIDs printed as examples
(`123e4567-e89b-12d3-a456-426614174000` and the like). It refuses a password
manager's letters and symbols too, since it can't tell those from words;
and a file over 1KB, or more than 24 hours old when you use it.

**The panel can't recognise every guessable value**, though. Text in an
encoding it doesn't read, a hash of the time or of a word it doesn't list,
or anything else worked out from something a stranger could guess can pass
these checks and still be guessed. So the token must come from one of the
commands above: don't type one, and don't derive one from anything.

A wrong token changes nothing: the file stays until it is used or expires,
so nobody else can use your token up by guessing. From anywhere but the
host itself the panel also never says whether the file exists: every
refusal reads `That reset token wasn't accepted. …`, and the panel's log
says which check failed (missing, too short, not hex, too predictable, text
written as hex, a well-known value, too old, or simply a different token).

If you see `This recovery action is only available when the panel is opened
from the server itself.` instead (no proxy mentioned), you're just not
browsing from the host — open the panel's URL from the machine it's
actually running on, or use a recovery code / `--reset-password`.

---

### RCON: connection refused vs wrong password

**What you see:** the server won't connect over RCON, but the two possible
causes look similar from the outside.

**What to do:** either the dashboard's reconnect action or **Servers → Test
Connection** now tells the two failure modes apart the same way:

- `Unreachable` / `Could not connect to RCON. Is the server running and RCON
  enabled?` — the panel couldn't even open a TCP connection. This means the
  PZ server isn't listening there at all: it's not running, `RCONPort` in
  its `.ini` doesn't match what you typed, a firewall is blocking it, or the
  host/IP is wrong.
- `Authentication failed` / `Connected to the server, but authentication
  failed. Check the RCON password in server settings.` — the panel reached
  the server and got a response, but the password you gave doesn't match
  `RCONPassword` in the PZ server's `.ini`. Keep `=` and line breaks out of
  that password: the game reads an `.ini` value only up to the first `=`, so
  it would use a shorter password than the one you typed here (the panel
  refuses to save one like that; `;`, `$`, `#` and quotes are fine).

(The exact wording differs slightly between the two entry points, but both
now distinguish the same two causes — neither collapses them into one
generic message anymore.)

Once connected, if a live command later drops the connection, watch for
these in the console/log — they map to the same two root causes:
- `Cannot connect to server. Is the game server running with RCON enabled?`
  (the server stopped, or RCON dropped)
- `Connection was reset. Server may have restarted or crashed.`
- `Authentication failed. Check RCON password in server settings.` (the
  password changed on one side but not the other)

**If the server is managed somewhere the panel can't see it** (a remote
host, a container the panel doesn't control, or anywhere its own
process-detection can't find the PZ process): the panel normally checks
"is the server process running" before it even attempts an RCON connection,
and that check can itself be slow or simply unable to see a server it
doesn't manage locally. Set `RCON_SKIP_SERVER_CHECK=true` to skip that
pre-check and let the RCON connection attempt itself be the test — safe
because it only removes an early skip, not any authentication or network
check.

---

### Broadcast messages show garbled text for Chinese or other non-Latin characters

**What you see:** a Scheduled Task server message, or a manually sent
broadcast, shows up in-game as garbled or mismatched characters instead of
the Chinese (or other non-Latin) text you typed — not blank boxes, but
wrong-looking text.

**What it means:** the panel sends the message to the PZ server as correct
UTF-8 over RCON — this has been independently verified byte-for-byte,
including the packet's length field, for exactly this kind of text.
Garbled-but-present characters are the signature of a *charset mismatch* on
the receiving side, not a transmission problem: something decoded valid
UTF-8 bytes using the wrong text encoding. The most likely cause is Project
Zomboid's own dedicated server — a Java process — falling back to the host
OS's default text encoding instead of UTF-8 when it reads the RCON command.
On a Chinese-locale Windows machine, that default is typically GBK, not
UTF-8.

**What to do:**
- On the machine running the **PZ dedicated server** (not the panel, and
  not the game client) — if it's Windows: **Settings → Time & Language →
  Language & Region → Administrative language settings → Change system
  locale → check "Beta: Use Unicode UTF-8 for worldwide language support"**,
  then restart the machine and restart the PZ server. This forces Java's
  default text encoding to UTF-8 system-wide and is the most likely fix.
- If you launch the PZ server yourself rather than through the panel's
  generated startup script, you can instead add `-Dfile.encoding=UTF-8` to
  the `java` command line that starts `zombie.network.GameServer` — same
  effect, scoped to that one process instead of the whole machine.
- If neither helps, try sending the same text through a different broadcast
  method (for example PanelBridge's in-game chat action instead of RCON
  `servermsg`, where available) to see whether the problem is specific to
  RCON or affects every broadcast path — that narrows down whether this is
  an RCON-decode issue or something in PZ's text rendering more generally.

---

### Panel says it cannot determine whether the server is running

**What you see:** an error like `Can't verify whether the server is
actually stopped — the process-detection scan itself failed, not the
server. Check the panel's log for the error. If this keeps happening,
something on this host (antivirus, a full disk, or a missing system tool)
may be blocking detection.` — usually when trying to restore a backup or
apply a config template.

**What it means:** these are wholesale-overwrite operations (restoring a
backup, applying a template, wiping the world, deleting chunks) that refuse
to run unless the panel can *positively confirm* the server is stopped. If
the process-detection scan itself fails (times out, or a Windows/Linux
process-scan command errors), the panel treats that identically to "server
is running" and refuses — it never guesses "probably stopped" to let a
destructive action through.

**What to do:** check the panel's own log for the actual scan failure (it's
usually a timeout or a missing/failing OS process-listing tool). Common
causes: antivirus intercepting the process scan, a full disk, or — on
Linux — a minimal container image missing `ps`. Fix that underlying cause,
then retry; there is no override switch for this by design.

If you're applying a **template** to a server that **isn't** your currently
active/selected one, you'll instead see: `Can't verify this server's running
state — the panel can only check the currently active server. Switch to
this server first, then apply the template.` The panel can only
process-scan whichever server is currently active, so it refuses rather
than assume an unchecked server is safely stopped. Switch to that server in
the UI first, then apply the template.

If the server in question is configured as a **remote server via SFTP**,
its status will show as `Cannot verify without SFTP access` in the host
badge — this is expected; the panel has no local process to scan for a
remote host and never claims otherwise.

---

### Server process exited immediately after starting (code=1, signal=none) — startup failed

**What you see:** clicking Start fails almost instantly with `Server
process exited immediately after starting (code=1, signal=none) —
startup failed.` On Windows, `server-launch.log` for that server is
either **missing entirely, or exists but is empty (0 bytes)** — that
pairing (this exact error, plus no real log content) is the fingerprint
of this specific bug, not a different startup failure.

Occasionally you'll instead see the same error with a short extra line
attached, something like `'...\ProjectZomboid' is not recognized as an
internal or external command...`. That's still this bug — see below for
why the log is sometimes empty and sometimes has that one line in it
instead.

**Which versions this affects:** **v1.2.15**, the current release, on
**Windows only** — v1.2.14 and earlier don't have this specific bug.
v1.2.14 launched the server executable by its bare filename rather than
its full path, so the install path itself never appeared on the command
line handed to `cmd.exe` at all (that version had a different Windows
bug of its own, since fixed, where a hardened system setting could stop
that bare-filename launch from being found). v1.2.15 fixed that by
launching with the full, absolute path instead — which is correct, but
newly exposes that path (and the panel's own log path, below) to
`cmd.exe`'s quote handling on the command line, which is what this bug
is in.

**What it means:** if the game server's install path, or the **panel's
own** logs folder (wherever the panel itself is installed or configured
to keep its data — not a per-server setting), contains a **space**
anywhere, or one of the characters **`&` `(` `)` `^`**, `cmd.exe`'s quote
handling on that command line breaks before the actual game server
executable ever runs. `cmd.exe` exits with code 1 and nothing resembling
the server starts — this is a bug in how v1.2.15 builds that command
line, not anything wrong with your install, your path choice, or your
server configuration.

The log behaves differently depending on which character triggered it,
which is why both symptoms above are the same bug: a bare **space** or
**`&`**/**`^`** makes `cmd.exe`'s own output redirection fail before the
log file is ever opened, so it's missing or stays at 0 bytes. A **`(`**
in the path instead makes `cmd.exe` fail at looking up the command *after*
redirection was already set up successfully, so the log exists and
contains that one `is not recognized` line — but the game server still
never ran, exactly as if the log were empty.

**What to do (today, before the fix is released):** make sure both the
game server's install folder and the panel's own install/data location
are on a path with **no spaces and none of `&` `(` `)` `^`** — for
example `D:\PZServer` rather than `D:\Program Files\PZ Server (x86)`.
This is a workaround, not the intended fix; there is nothing else you
need to change, and nothing about your server's own configuration
(`.ini`, mods, RCON) is involved.

**When does a real fix arrive:** the fix exists in this project's source
today but **has not shipped in any released version yet** — v1.2.15 is
still the latest release and still has this bug. Once a release contains
it, you'll be able to use a path with spaces or these characters again
without the workaround above; this page will be updated to name that
version once it exists. Don't take "the code is fixed" to mean "my
installed copy is fixed" — check your actual version against the
release notes before assuming an upgrade already covers this.

---

### The startup script `start-server_<name>.sh` is missing from this server's install folder

**What you see:** Start or Restart fails with `The startup script
start-server_<name>.sh is missing from this server's install folder`
(`StartServer_<name>.bat` on Windows). The Scheduler page's Execution
History and the panel log show the same refusal as `Startup script
start-server_<name>.sh is missing from <folder>`. For the panel's auto-start,
the log line begins with `Error during auto-start`, followed by the server's
name when it isn't the active one.

A Restart of a running server (Dashboard, Discord, a scheduled or
mod-update restart) checks this before it warns players, saves or stops
anything. If the script is missing and the panel can't write it, the
restart is called off and the server keeps running. The message then
begins `Restart called off before stopping the server`, and the panel log
line just above it begins `Restart refused before stopping the server` and
names the error. Fix it the same way as below, then restart again.

**What it means:** before every start, the panel writes this server's own
startup script from its settings (server name, save folder, admin password,
memory) into the folder the game is launched from. This time the write
failed and no older copy was there. The panel won't run the game's stock
`start-server.sh` or `StartServer64.bat` instead: it opens the default
`servertest` world, not your server, and can stop at a prompt for a new
admin password.

**What to do:** search the panel log for `Could not write` (or, for a
called-off Restart, `Restart refused`) just above the refusal. It names the
file and the error. Almost always the panel's account
can't write to that folder: see
[Permission denied on mounted PZ folders](#permission-denied-on-mounted-pz-folders)
(on Docker, check `PUID` and `PGID`). Also check that the install path in
**My Servers** still points at a folder that exists. Then press Start again.

**Debug › Diagnostics** checks for this before you press Start. Its "Start
script" row names the server's own script, not the stock one. "Start script
missing" (a failure) means the script isn't there and the panel can't write
to the folder. "Start script not written yet" (a warning) means the next
start will write it. Windows doesn't let the panel check folder permissions
ahead of time, so there a folder it can't write also shows as the warning.

If an older copy of the script is in that folder, the start doesn't stop.
It runs that copy, and the log warns `Could not regenerate ... which may
carry older settings`. A password or memory change you made since then
won't reach the game until the panel can write the script again.

---

### The game stops responding after a world save: `UnsatisfiedLinkError` (Linux)

**What you see:** after a world save, the game stops answering. RCON keeps
disconnecting, the Dashboard shows the server running but unresponsive, and
Stop, Restart or an update says the world could not be saved. The game's
`DebugLog` shows `java.lang.UnsatisfiedLinkError` naming a
`zombie.popman.ZombiePopulationManager` method, such as
`n_updateRealZombies`.

**What it means:** the game loaded native libraries from an older build.
SteamCMD doesn't remove a folder a newer build stopped shipping, so an
install updated across builds can keep a `natives/` folder next to the
current `linux64/` one. Older panel versions wrote start scripts that put
`natives/` first. The panel's script now loads the folders the game's own
`ProjectZomboid64.json` names (`linux64/` for Build 42.21), or `linux64/`
before `natives/` when it can't use that file, and it is rewritten before
every start. A custom launcher, a Docker image's start command, or a
`ProjectZomboid64.json` that puts `natives/` first still loads the old
libraries.

**What to do:**

1. If the server is stuck, use **Force stop** on the Dashboard. It tries one
   quick save while RCON is connected (a stuck server usually can't answer
   it), then stops the server either way, so anything since the last
   successful save can be lost. The panel never does this for you.
2. With the server stopped, rename the leftover folder in the install
   folder, for example `mv natives natives.old`. Renaming can be undone. If
   Diagnostics says `natives/` also holds libraries `linux64/` doesn't have,
   verify the game files with SteamCMD first.
3. Start the server again.

**Debug › Diagnostics** shows "Old game libraries in natives/" while that
folder is there and its libraries differ from `linux64/`, or "Older game
libraries load first" when `ProjectZomboid64.json` puts `natives/` first.
The panel log warns `Leftover native libraries from an older game build`
before every start.

---

### Permission denied on mounted PZ folders

**What you see (Linux/Docker):** `Cannot read /some/path (EACCES). The
panel service account needs read and execute permission on this folder and
every parent folder.`

**What you see (Windows):** `Cannot read C:\some\path (EPERM). Run the
panel as an account that can read this folder.` (Windows permission errors
surface as `EPERM`, not `EACCES` — the code in parentheses is whatever the
OS actually returned, so treat the exact code as informational, not a
required match.)

**What it means:** the panel process's user doesn't have permission to
read a folder you pointed it at — almost always a PZ install or save
folder mounted into a Docker container with the wrong owner.

**What to do (Docker):** set `PUID` and `PGID` in `.env` to the numeric
Linux user/group that actually owns the PZ folders on the host (find them
with `id -u` and `id -g` on the host, run against the PZ folder's real
owner, not necessarily your own login), then `docker compose up -d` to
restart with the new values. `PUID`/`PGID` only apply when the container
starts as root, which is the default — if your runtime already pins a
non-root user (for example a Kubernetes pod with `runAsUser`), the
entrypoint skips its own ownership fix, and the mounted folder must already
be writable by that UID/GID instead.

**What to do (bare metal):** on Linux, confirm the account running the
panel (or the systemd service's configured user) has read+execute on the
target folder **and every parent folder** — a readable target folder behind
an unreadable parent still fails. On Windows, run the panel as (or grant
folder permissions to) an account that can read the path.

---

### PanelBridge shows disconnected

**What you see:** the PanelBridge status badge reads **"Bridge offline"**
(hint: *"Go to Settings → Bridge to configure"*) or **"Bridge waiting"**
(hint: *"Watching for PZ mod — start/restart the server"*).

**What it means:**
- **"Bridge waiting"** means the PZ server process is running, but the
  panel hasn't seen the mod check in yet. This is normal for the first
  minute or so after a (re)start while the mod initializes.
- **"Bridge offline"** means either the server isn't running, or
  PanelBridge isn't configured/installed at all.

**What to do:**
1. Check **Settings → PanelBridge → How PanelBridge is installed**:
   - **Installed by the panel**: `PanelBridge.lua` must be in the server's
     `Install/media/lua/server/` folder. The panel copies it there for you
     (the block says *"PanelBridge isn't installed in this game folder
     yet."* and offers **Install now** if it isn't), unless you're on a
     remote server without shared filesystem access — see the Indifferent
     Broccoli / remote-SFTP guide, [hosted.md](hosted.md), for that path
     instead.
   - **Steam Workshop**: the block says whether the server loaded it.
     *"Takes effect at the next start."* means the server hasn't started
     since the switch. For anything else, see
     [PanelBridge not loaded from the Workshop](#panelbridge-not-loaded-from-the-workshop)
     and [Server won't start after switching to the Workshop](#server-wont-start-after-switching-to-the-workshop)
     below.
2. `DoLuaChecksum` doesn't stop the server from loading PanelBridge. It
   decides whether players can join — see
   [Players refused with a file mismatch](#players-refused-with-a-file-mismatch).
3. Fully restart the PZ server (not just save/reload) — the mod only loads
   on boot.
4. If it's been well over a minute since restart and it's still stuck on
   "Bridge waiting," check the PZ server's own console/log for a Lua error
   from PanelBridge, and check the panel's log for whether it's still
   watching for the mod's status file at all. Four `NoSuchFileException`
   errors naming `ZCPB` aren't the cause; see
   [Server console shows NoSuchFileException errors naming ZCPB](#server-console-shows-nosuchfileexception-errors-naming-zcpb).
5. For a remote server without a shared filesystem, confirm **Settings →
   PanelBridge → Remote connection** has a working SFTP connection
   ("Verify and prepare SFTP" succeeds) and that **Start SFTP bridge** has
   actually been clicked — the badge stays offline until that bridge is
   running, even with valid credentials saved.

---

### Server won't start after switching to the Workshop

**What you see:** after you switched a server to Steam Workshop delivery,
it stops during startup. **Settings → PanelBridge → How PanelBridge is
installed** reads **The server didn't start**, with one of:
- *"The server stopped while getting PanelBridge from the Steam
  Workshop."*, followed by the line from the server's console log that
  shows it, such as `Workshop: onItemNotDownloaded itemID=<id> result=<n>`
  or `Workshop: GetItemInstallFolder() failed ID=<id>`.
- *"The server couldn't connect to Steam and stopped before downloading
  anything."* — the console log has `Failed to connect to Steam servers`.

The block can also say *"Steam reports the PanelBridge Workshop item as
unavailable."* when Steam lists the item as hidden or removed.

**What it means:** a server stops at startup when an item in its
`WorkshopItems=` line can't be downloaded, and PanelBridge's item is no
exception. The panel tells the two cases apart from the server's latest
`server-console.txt`, which the game rewrites at every start. It can only
do that when it can read the server's files; for a hosted or remote
server, look for the same lines in your provider's console.

`Failed to connect to Steam servers` isn't specific to PanelBridge: every
dedicated server running in Steam mode checks its Steam connection at
startup and stops without it, however PanelBridge is installed. Switching
back to panel-installed doesn't fix that.

**What to do:**
- **The download failed:** click **Switch to panel-installed and start**.
  The panel copies `PanelBridge.lua` back into the game folder, removes
  both entries from the `.ini`, sets `DoLuaChecksum=false`, and starts the
  server. Try the Workshop again later. On a hosted server, **Switch to
  panel-installed** lists the same changes for you to make: remove the two
  entries, upload `PanelBridge.lua` to `media/lua/server/`, set
  `DoLuaChecksum=false`, and restart from your provider's dashboard.
- **Steam couldn't be reached:** check the network, firewall or proxy of
  the machine that runs the server, then click **Start server** once Steam
  can be reached.

---

### New players can't join after a PanelBridge update

**What you see:** on a server that gets PanelBridge from the Steam
Workshop, players can't join after a new PanelBridge version was
published. Their game says *"Workshop item version is different than the
server's"* for Zomboid Control Panel Bridge.

**What it means:** a server downloads its Workshop items when it starts
and keeps those versions until it restarts. Once a newer version is on the
Workshop, joining players get the newer one, and they can't join until the
server restarts and downloads it too. Every Workshop mod works this way.
The panel-installed PanelBridge doesn't: its updates arrive with panel
updates. The Mods page flags the PanelBridge update like any other
Workshop update.

**What to do:** restart the server. To have that happen by itself, turn on
**Settings → Mods & Workshop → Auto-restart server when mods update**;
Settings → PanelBridge says whether it is on. PanelBridge updates are
batched, so this should be rare.

---

### I can't join my own server by its public IP (but friends can)

**What you see:** friends connect fine, but from the same network as the
server you get stuck on "connecting" or a loopback / timeout error when you
use the public IP or domain name.

**What it means:** many home routers don't support NAT loopback (hairpinning),
so a machine on the LAN can't reach the router's own public address.

**What to do:** from inside your network, join with the server's LAN IP
(for example `192.168.1.20`) or `127.0.0.1` if it runs on the same PC. Keep
the public IP for people outside your network.

---

### Admins can join but players can't

**What you see:** with `DoLuaChecksum=true`, your admin account joins, but
a normal player account is refused or kicked while loading.

**What it means:** admin accounts skip the Lua integrity check (the game's
`BypassLuaChecksum` capability). Normal player accounts don't, so an admin
getting in proves nothing about the check.

**What to do:** always test the check with a normal player account. If
that account is refused, see the next section.

---

### Players refused with a file mismatch

**What you see:** with `DoLuaChecksum=true`, players are refused while
loading. The error can read *"File doesn't match the one on the server"*
or *"File doesn't exist on the client"*, and the server's console logs
that the player will be kicked because Lua/script checksums do not match.

**What it means:** the check compares players' Lua, script and animation
files with the server's, and refuses any player whose files differ. The
usual causes, most likely first:
- **The panel-installed PanelBridge with the check on.** The loose
  `PanelBridge.lua` is a server Lua file players don't have, so every
  player without admin rights is refused. Settings → PanelBridge shows
  **Players can't join this server right now**.
- **Old PanelBridge files in the game folder with Workshop delivery.** A
  leftover `media/lua/server/PanelBridge.lua` or
  `media/lua/client/PanelBridgeClient.lua` next to the Workshop copy still
  gets players refused. Settings → PanelBridge lists them (*"Old
  PanelBridge files are still in the game folder: …"*), and so does
  **Debug & Logs → Checks & Fixes** (*"Old PanelBridge files in the game
  folder"*).
- **A Linux server with Windows or Mac players.** Earlier game builds
  (41.77, 42.13–42.14) refused Windows and Mac players on Linux servers
  with this check on, even with identical files. It isn't confirmed fixed
  on the current build.
- **A player's own modified files.** That is the check doing its job.

**What to do:**
- Panel-installed: click **Turn the check off** in Settings → PanelBridge
  and restart, or switch to Steam Workshop delivery to keep the check on.
- Leftover files: start or restart the server **from the panel**, which
  moves them into the panel's data folder (`bridge-delivery-archive/`). A
  start from anywhere else leaves them. On a hosted server, delete them
  with your provider's file manager.
- Linux server: if only players on another OS than the server are refused,
  turn the check off again — **Turn it off again** in Settings →
  PanelBridge, or `DoLuaChecksum=false` in the `.ini` — and restart.

---

### PanelBridge not loaded from the Workshop

**What you see:** Settings → PanelBridge reads *"The server started, but
PanelBridge didn't load from the Workshop."* Or every player is refused
with *Mod "…" is not installed*, naming PanelBridge's mod.

**What it means:** the server's console shows which copy ran, on the line
`[PanelBridge] Loaded from: …`: `workshop` and the item ID for the
Workshop item, `loose` for a `PanelBridge.lua` in the game folder, `mod`
for a copy in a mods folder. The usual causes:
- **The `.ini` entries were removed or changed outside the panel** — a
  hand edit, your provider's mod list, another tool. A start or restart
  from the panel adds them back; a start from anywhere else doesn't.
- **The server launched without Steam** (`-nosteam`, a GOG or LAN setup).
  Workshop items never download in that mode, and a `Mods=` entry for an
  item that isn't there refuses every join with *Mod "…" is not
  installed*. The panel won't offer the Workshop to a profile it knows
  launches without Steam, and refuses **Launch without Steam** on a
  Workshop server. If the server uses its own launch script, check that
  the script doesn't start it without Steam.
- **The server runs Build 41.** The PanelBridge Workshop item is for
  Build 42. The panel blocks the switch once PanelBridge has reported the
  game version; before that it only warns *"The panel can't confirm this
  server runs Build 42 yet."*
- **Another mod ships `media/lua/server/PanelBridge.lua`** and replaces
  this one.

**What to do:** restart the server from the panel. On a hosted server,
check the two `.ini` entries and your provider's startup parameters, then
restart from its dashboard. If PanelBridge still doesn't load, click
**Switch to panel-installed** in Settings → PanelBridge.

---

### Server console shows NoSuchFileException errors naming ZCPB

**What you see:** on a server that loads PanelBridge as a mod (Steam
Workshop delivery, or a copy in a `mods` folder), the server console
(`server-console.txt`) logs four `ERROR` entries with Java stack traces
while the server starts. Each reads
`AdvancedAnimator$1.visitFileFailed> Exception thrown`, then
`java.nio.file.NoSuchFileException` for one of these folders:
- `…/mods/ZCPB/common/media/AnimSets`
- `…/mods/ZCPB/common/media/actiongroups`
- `…/mods/ZCPB/42/media/AnimSets`
- `…/mods/ZCPB/42/media/actiongroups`

**What it means:** nothing is wrong. At startup the game looks for
animation files in the folders of every mod in `Mods=`, and logs an error
for each of those folders that doesn't exist. `ZCPB` is PanelBridge's mod
ID, and PanelBridge only has Lua files, so it has none of them. Any other
Lua-only mod gets the same lines. PanelBridge still loads: look for
`[PanelBridge] Loaded from: …` further down the console. The
panel-installed `PanelBridge.lua` isn't a mod, so it doesn't cause these
lines.

**What to do:** nothing. Don't create the missing folders to silence the
errors: they're harmless, and with Workshop delivery Steam manages the mod
folder. If PanelBridge doesn't work, look for other lines that mention
`PanelBridge` instead, and see
[PanelBridge shows disconnected](#panelbridge-shows-disconnected).

---

### Death notices for a player who didn't die

**What you see:** a Discord **Player Death** notice (by default
*"💀 **{player}** died at {location}"*), or a death in a player's history,
for a player who is alive.

**What it means:** the panel takes deaths from PanelBridge, which reports
them from the character that died. Without an up-to-date PanelBridge (not
installed, an older version, or not answering), it falls back to the
game's user log (`Logs/*_user.txt`), and that log can be forged: a co-op
(split-screen) player's name skips the server's username check, so a
player who joins can pick one that writes a death line for anyone.
`AllowCoop` is on by default.

**What to do:**
- Update PanelBridge to the one that comes with panel v1.4.6 or later, and
  restart the server: a panel-installed PanelBridge updates with the panel,
  a Workshop one downloads at the next start, and on a hosted server you
  upload the new `PanelBridge.lua` (see [hosted.md](hosted.md)).
- If you can't, and nobody on the server plays split-screen, set
  `AllowCoop=false` in the server's `.ini` and restart.

---

### Blank or partial World Map

**What you see:** the map area shows one of:
- **"No players on the map"** (subtitle: *"Player positions appear when
  PanelBridge is connected"*) — this isn't a map failure at all; it means
  no player position data is flowing, which needs PanelBridge connected
  (see the section above).
- **"Map tiles aren't loading"** (*"Panel can't reach tiles.pzmap.org. Check
  outbound HTTPS access and try Refresh."*) — the panel's own server
  couldn't reach the tile CDN at all. The map proxies and caches tiles
  server-side, so this is the panel host's outbound network, not your
  browser's.
- **"No map tiles at this zoom"** (*"tiles.pzmap.org is reachable but
  hasn't rendered this area at this detail level. Zoom out, or try Refresh
  later."*) — the CDN is reachable, but doesn't have tiles for exactly this
  area/zoom yet. Zooming out usually resolves this immediately.

**What to do:** for the two tile-related messages, check **Debug & Logs →
Diagnostics → World Map** for the same signal in more detail — a `B42 tile
CDN unreachable` finding there confirms it's the panel host's outbound
HTTPS access, not something wrong with your server. Also watch for a `B42
build auto-detect failed` warning: the panel normally detects the current
PZ map build automatically from `tiles.pzmap.org`, but if that discovery
fails, it silently falls back to a hardcoded older build, which will not
track the next PZ map release and can present as a wrong/stale map layout
rather than a missing one — the Diagnostics finding names which reason
discovery failed.

`curl` must be present on the panel host for build auto-detection to work
at all (Docker, Windows, and macOS packages already include it; a bare
Linux tarball install might not) — without it, the map still works, it just
never tracks a new PZ map release, and Diagnostics will flag it.

---

### Mod conflict scan stopped early / incomplete

**What you see:** a warning in the Mod Conflicts panel reading `File index
reached the global 300,000-entry limit — the conflict scan is incomplete.
Scan fewer mods at once or remove unused ones and retry.`

**What it means:** the scan indexes every file across every active mod to
detect overlaps, and stops rather than silently reporting a partial result
as if it were complete, once the combined file count crosses a fixed safety
ceiling (guarding against a crash on pathological, extremely large mod
lists).

**What to do:** disable mods you aren't actually using, or scan a smaller
subset at a time, then retry.
