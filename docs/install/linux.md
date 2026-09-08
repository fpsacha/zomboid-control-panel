# Installing on Linux (bare metal or VPS)

This guide is for running the panel directly on a Linux machine — your own
server, a home box, or a rented VPS — without Docker. If you'd rather use
Docker, see the Docker section of the main [README](../../README.md#docker-and-unraid)
instead; it's simpler and skips most of the OS-level setup below.

Written for a first PZ server install. Each phase ends with a way to check
you did it right before moving to the next one.

---

## Phase 1: Extract and run the panel

1. Download `ZomboidControlPanel-linux.tar.gz` from
   [Releases](https://github.com/fpsacha/zomboid-control-panel/releases/latest).
2. Make a folder for it and extract the archive into it:
   ```bash
   mkdir zomboid-panel && cd zomboid-panel
   tar xzf ZomboidControlPanel-linux.tar.gz
   ```
3. Make the launcher executable and run it:
   ```bash
   chmod +x start.sh
   ./start.sh
   ```

**You know it worked when:** the terminal prints `Starting Zomboid Control
Panel...`, then — a few seconds later, once the panel process itself has
bound its port — a boxed **Ready** section listing a `Local:` URL (for
example `http://localhost:3001`). Use whatever port that box actually
shows, not blindly `3001` (see [Phase 8 of the Windows
guide](windows.md#phase-8-what-to-do-if-port-3001-is-already-taken) for why
it can differ). That URL loads the setup screen in a browser.

**If this goes wrong:** `./start.sh: Permission denied` means step 3's
`chmod +x` didn't run or didn't apply — repeat it. `ERROR: ./ZomboidControlPanel
was not found in this folder` means the archive was extracted somewhere else,
or you're running `start.sh` from outside the folder you extracted into — `cd`
back into it first.

Leave this terminal running for now — closing it stops the panel. Phase 6
below covers turning this into a proper background service.

---

## Phase 2: Create the first-run admin account

Nobody owns this panel yet. Nothing else in this guide works until you do
this step, since every later phase assumes you're logged in.

1. In the terminal from Phase 1, find the line starting with `SETUP TOKEN
   required to complete first-run setup:` followed by a long string of
   letters and numbers. Copy that string — treat it like a password; anyone
   who has it can create the admin account before you do.
2. Open the `Local:` URL from Phase 1 in a browser (on the same machine, or
   from another one on your network if you've already sorted out access to
   it). You'll see the setup screen with a **Setup Token** field, a **Panel
   Port** field (leave this at whatever port Phase 1's Ready box actually
   showed), a username, and a password.
3. Paste the setup token, choose a username and password, confirm the
   password, and submit.

**You know it worked when:** the setup screen closes and you land on the
panel's dashboard, logged in.

**If this goes wrong:** `Invalid or missing setup token` means the token was
mistyped or scrolled out of view in the terminal — scroll back up, or
restart `start.sh` to print a fresh copy of the *same* token (it doesn't
change on restart, only on first use, and only when nobody has finished
setup yet).

---

## Phase 3: Confirm your distro is new enough

The panel binary needs **glibc 2.28 or newer**. This is a property of your
Linux distribution, not something you install separately.

Known to clear the floor: Ubuntu 20.04+, Debian 10+, CentOS Stream 8+, Rocky
8+, and anything comparably current. **CentOS 7 does not clear it** (it ships
glibc 2.17) — use Docker on CentOS 7 instead, not this guide.

`start.sh` (Phase 1) already checks this for you automatically and prints a
warning if your glibc is too old. To check it yourself:

```bash
ldd --version | head -1
```

**You know it worked when:** `start.sh` printed no glibc warning, or the
version from the command above is 2.28 or higher.

**If this goes wrong:** the panel binary itself may refuse to start, or crash
immediately with a dynamic-linker error mentioning `GLIBC_2.28` or similar.
There's no workaround on an old distro other than upgrading the OS or
switching to Docker.

---

## Phase 4: Install curl

`curl` isn't bundled with every minimal Linux install, and the panel uses it
for one specific feature: detecting new Project Zomboid map builds for the
**World Map** page. Docker, Windows, and macOS installs already have `curl`;
a bare tarball install on a minimal Linux image might not.

```bash
# Debian / Ubuntu
sudo apt install curl

# RHEL / CentOS / Rocky
sudo dnf install curl
```

**You know it worked when:** `curl --version` prints a version instead of
`command not found`.

**If you skip this:** nothing crashes. The panel still runs and the World Map
still works — it just falls back to a fixed, older map build and stops
tracking new Project Zomboid map releases. **Debug > World Map** in the panel
will flag this if it happens, so you can catch it later even if you skip this
step now.

---

## Phase 5: Run as a dedicated user, not root

`start.sh` prints a warning if you run it as root. Don't ignore it — create a
low-privilege user instead:

```bash
sudo useradd -r -m -s /bin/false pzuser
```

You don't need to do anything with this user yet by hand — Phase 6 below sets
the systemd service to run as `pzuser` automatically, and hands it ownership
of the panel's own folder. If you're just testing manually in a foreground
terminal (Phase 1) as your normal login user, that's fine for now; this
matters once you install the service.

**You know it worked when:** `id pzuser` prints a UID/GID instead of `no such
user`.

**Don't run the panel as root "just once to look at it," even before doing
this phase.** The very first run creates its data directory — the database,
its startup backup, the JWT signing key, the log files — owned by whichever
account started it. If that first run was root and every run after is
`pzuser` (Phase 6's service), that account can no longer read or write any of
it, and the panel refuses to start rather than run in a half-broken state.
The fix is a `chown -R` back to the account you actually run it as — the
panel's own error message prints the exact command, naming every affected
path, when this happens — but it's simpler to just create `pzuser` (above)
**before** the very first run, so there's no root-owned first run to undo.

**If you skip this:** the panel keeps running fine as root, but every file it
touches (its database, logs, and anything a PZ server writes under its
management) ends up root-owned, and a bug or a compromised dependency in the
panel process has full system privileges instead of being contained to one
low-privilege account.

---

## Phase 6: Install the panel as a systemd service

This makes the panel start automatically on boot and restart itself if it
crashes, instead of you needing a terminal open. The archive from Phase 1
already includes the unit file — `zomboid-panel.service` — sitting right next
to `start.sh`.

1. Stop the foreground copy from Phase 1 (`Ctrl+C`) if it's still running.
2. Move the whole extracted folder into `/opt`, and hand it to `pzuser`:
   ```bash
   sudo mkdir -p /opt/zomboid-panel
   sudo cp -r ./* /opt/zomboid-panel/
   sudo chown -R pzuser:pzuser /opt/zomboid-panel
   ```
3. Install the unit file and start the service:
   ```bash
   cd /opt/zomboid-panel
   sudo ./install-linux-service.sh --enable
   ```
4. Check it's actually running:
   ```bash
   sudo systemctl status zomboid-panel
   ```

**You know it worked when:** `systemctl status` shows `active (running)`, and
`http://your-server-ip:3001` still loads.

The installer is deliberately explicit: the panel never invokes `sudo` and
normal in-app updates never edit `/etc`. If a unit is already installed and
differs from the bundled template, the installer creates a timestamped backup
before replacing it. Without `--enable`, it installs the unit and runs
`daemon-reload` but does not enable, start, or restart the service.

The bundled unit starts `start.sh` with `KillMode=process`. The launcher places
the panel in its own process group and forwards service stop signals only to
that group. Project Zomboid is detached into a different process group, so a
panel-only restart or update does not stop the game server. Do not remove these
settings unless the game server is managed by a separate service.

### Paths and environment variables shown in the UI

Linux and other POSIX shells expand variables as `$NAME` or `${NAME}`; Windows
Command Prompt uses `%NAME%`. In particular, `%TEMP%`, `%USERPROFILE%`, and
`%PATH%` are Windows syntax and should not be copied into a Linux shell. The
panel obtains its real temporary directory from the running Node process and
shows a concrete log path instead of assuming that `$TEMP` or `$TMPDIR` exists.

For Java checks, use `command -v java` on Linux and `where java` on Windows.
Remember that a systemd service can have a different `$PATH` from an interactive
login shell; check `systemctl show zomboid-panel --property=Environment` and the
service journal when a command works in your terminal but not in the panel.

### The `ReadWritePaths` trap

The bundled unit file locks the panel down with systemd sandboxing
(`ProtectSystem=full`, etc.) and only grants write access to two folders:

```
ReadWritePaths=/opt/zomboid-panel
```

This is fine as long as everything the panel needs to write — including any
PZ server it manages — lives under `/opt/zomboid-panel`. Phase 7 below has
you use exactly that layout (`/opt/zomboid-panel/data/pzserver`), so if you
follow it as written you won't hit this.

**If you deviate and point the panel at a PZ install outside `/opt/zomboid-panel`
(for example, `/opt/pzserver`)**, the service will fail to write there —
SteamCMD installs, saves, and config edits will fail with permission errors,
even though the same install path works fine when you run `./start.sh`
manually as your own user. The fix is to explicitly add the extra path (and
its matching `_Data` folder) to `ReadWritePaths` in the unit file, then reload
it:

```bash
sudo nano /etc/systemd/system/zomboid-panel.service
# change the ReadWritePaths line to:
# ReadWritePaths=/opt/zomboid-panel /opt/pzserver /opt/pzserver_Data
sudo systemctl daemon-reload
sudo systemctl restart zomboid-panel
```

Both paths are required — the panel creates a matching `..._Data` sibling
folder next to whatever install folder you give it, for server settings and
save data, and systemd will block writes to that one too if it's missing from
the list.

**If this goes wrong:** `systemctl status` shows `failed` or
`activating (auto-restart)` in a loop — check `journalctl -u zomboid-panel -n
50` for the actual error. A permission-denied error mentioning a path outside
`/opt/zomboid-panel` almost always means the `ReadWritePaths` trap above.

**A separate trap this same sandboxing used to cause:** SteamCMD writes its
*own* client state (login cache, depot/workshop staging, logs) to
`$HOME/Steam` — a completely different location from wherever you point
`+force_install_dir`. The bundled unit also sets `ProtectHome=read-only`,
which blocks that write unconditionally, with no `ReadWritePaths` entry able
to fix it (short of granting write access to your whole home directory,
which isn't worth doing for this). This showed up as SteamCMD failing with
"Missing file permissions" or "Missing configuration" (`exit code 8`) even
when `/opt/zomboid-panel` itself had correct ownership and permissions — the
error was real, it just wasn't about the path you'd been told to `chown`.
The panel now redirects SteamCMD's `$HOME` to a `.steamhome` folder inside
its own SteamCMD directory (already covered by whatever `ReadWritePaths`
entry that directory needs anyway — see above), so this no longer requires
any manual fix. If you're on an older panel version and still see this
error, updating resolves it; there's nothing to change in the unit file.

---

## Phase 7: Install a PZ server through the panel wizard

If you installed the service as in Phase 6, the panel runs as `pzuser` and
can only write inside `/opt/zomboid-panel` (see the trap above). Point the
setup wizard at a folder under there, and create it **before** you open the
wizard — the wizard does not create its own top-level folder:

```bash
sudo -u pzuser mkdir -p /opt/zomboid-panel/data/pzserver
```

Then in the panel, use this exact path as the install folder:

```
/opt/zomboid-panel/data/pzserver
```

The panel creates a second folder, `/opt/zomboid-panel/data/pzserver_Data`,
on its own for server settings and save data — you don't need to create that
one yourself. Leave **Custom config location** blank unless you specifically
need the `.ini`/`_SandboxVars.lua` files stored somewhere else.

**You know it worked when:** the wizard's install step starts downloading
through SteamCMD instead of immediately failing on the folder path.

**If this goes wrong:** an immediate permission error on the very first
install step means either the folder from step 1 above wasn't created, or it
was created as your login user instead of `pzuser` (drop the `sudo -u pzuser`
and it'll be owned wrong). A permission error partway through — after
download starts — points at the `ReadWritePaths` trap in Phase 6 instead,
usually because a **Custom config location** was set outside
`/opt/zomboid-panel`.

---

## Phase 8: SteamCMD's 32-bit library dependencies

The wizard downloads and runs SteamCMD for you — you don't install SteamCMD
yourself. But SteamCMD's own binary is 32-bit, and on a 64-bit Linux install
the OS doesn't have 32-bit runtime libraries installed by default. Install
them once, before running the wizard in Phase 7:

```bash
# Debian / Ubuntu
sudo apt install lib32gcc-s1 lib32stdc++6

# RHEL / CentOS / Rocky
sudo yum install glibc.i686 libstdc++.i686
```

**You know it worked when:** the SteamCMD download step in the wizard (Phase
7) completes instead of hanging or exiting immediately.

**If you skip this:** the panel's own install flow tries to detect the
problem and will emit a warning in the install log along the lines of *"Could
not verify 32-bit libraries. If SteamCMD fails, install: ..."* with the same
package names as above — but the detection isn't foolproof. If SteamCMD
exits instantly with no useful output, or the install step just hangs, this
is the first thing to check even if you didn't see that warning.

---

## Phase 9: Open the firewall

Only needed if you're accessing the panel from another machine (see
[Remote Access](../../README.md#remote-access) in the README for the
matching `CORS_ORIGINS` step) — skip this if you're only ever opening
`http://localhost:3001` on the same machine the panel runs on.

```bash
# ufw (Debian / Ubuntu)
sudo ufw allow 3001/tcp
sudo ufw reload

# firewalld (RHEL / CentOS / Rocky)
sudo firewall-cmd --permanent --add-port=3001/tcp
sudo firewall-cmd --reload
```

This opens the **panel's** port only. Your PZ server has its own game and
RCON ports (RCON defaults to `27015`, set in the server's own `.ini`) — those
are separate and only need opening if the game server and the panel are on
different machines or players connect over the internet.

**You know it worked when:** the panel loads at `http://your-server-ip:3001`
from the other machine.

**If this goes wrong:** a connection that hangs and times out (rather than
being actively refused) almost always means the firewall step above, not the
panel itself — check `sudo ufw status` or `sudo firewall-cmd --list-ports`
shows `3001` before looking anywhere else.

---

## Phase 10: Reverse proxy and account recovery

Skip this phase entirely if you're not putting the panel behind nginx, Caddy,
or another reverse proxy — everything below only applies once you set
`TRUST_PROXY` (see the [Remote Access](../../README.md) notes and the
`TRUST_PROXY` comment in `zomboid-panel.service`).

Setting `TRUST_PROXY` is what tells the panel "the network connection you see
for every request is the proxy, not the real visitor" — necessary for
rate-limiting and secure-cookie logic to work correctly behind a proxy. It
also has a side effect the panel is explicit about: **once `TRUST_PROXY` is
set, the panel stops being able to tell whether any given request originated
from the server's own console versus a remote browser**, even if you're
physically sitting at the machine.

That matters for exactly one feature: the panel normally lets you request a
one-time password-reset token *without any prior login*, but only when the
request is detected as coming from the server itself (loopback or one of the
machine's own network addresses) — the idea being that if you can already
reach the server directly, you don't need to prove anything else. Behind a
reverse proxy, this path is disabled outright and returns an explicit error
rather than guessing — the panel would rather fail closed than risk treating
a remote visitor as local.

If you get locked out while running behind a reverse proxy, you still have
two options that don't depend on how the request reached the panel:

- **Recovery codes** — single-use codes you generate in advance from an
  already-logged-in admin session (**Settings > Security**, recovery section).
  Generate these *before* you need them.
- **The `--reset-password` CLI flag**, run directly on the server:
  ```bash
  sudo systemctl stop zomboid-panel
  cd /opt/zomboid-panel
  sudo -u pzuser ./ZomboidControlPanel --reset-password
  sudo systemctl start zomboid-panel
  ```
  Stopping the service first avoids two processes touching the panel's
  database at the same time.

**You know it's set up right when:** you can see, before you ever get locked
out, that **Settings > Security** shows recovery codes already generated and
saved somewhere safe.

---

## Summary checklist

- [ ] Panel starts via `start.sh` and loads at `:3001` (Phase 1)
- [ ] Admin account created using the terminal's setup token (Phase 2)
- [ ] Distro clears the glibc 2.28 floor (Phase 3)
- [ ] `curl` installed, so World Map stays on the latest build (Phase 4)
- [ ] Panel runs as `pzuser`, not root (Phase 5)
- [ ] `zomboid-panel.service` installed and `active (running)` (Phase 6)
- [ ] `/opt/zomboid-panel/data/pzserver` created before the install wizard (Phase 7)
- [ ] 32-bit libraries installed so SteamCMD runs (Phase 8)
- [ ] Firewall open on 3001, only if accessed remotely (Phase 9)
- [ ] Recovery codes generated before going behind a reverse proxy (Phase 10)
