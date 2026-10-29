# Installing on Windows

This guide is for running the panel directly on a Windows PC or Windows
server — your gaming rig, a home box, or a rented Windows VPS — using the
packaged release. If your last software install was a game, this is written
for you: numbered steps, one action per step, and a way to check you did it
right before moving to the next one.

---

## Phase 1: Download and extract the release zip

1. Download `ZomboidControlPanel-windows.zip` from
   [Releases](https://github.com/fpsacha/zomboid-control-panel/releases/latest).
2. Right-click the downloaded zip → **Extract All...** → pick a folder (for
   example `C:\ZomboidPanel`) → **Extract**.

   On a PC other people also sign in to (a shared or rented server with
   several Windows accounts), extract it inside your own user folder instead
   (for example `C:\Users\<you>\ZomboidPanel`): a folder made directly under
   `C:\` lets every account on the PC change the panel's program files. The
   panel itself keeps its secret files (`data\jwt.secret`, `data\db.json` and
   the other `.secret` files) readable only by the account that runs it,
   SYSTEM and Administrators.

   Don't run anything straight out of the zip's built-in preview window —
   always extract first. Windows Explorer lets you double-click files inside
   a zip without extracting, and this project's launcher (Phase 2) needs its
   sibling files on disk next to it to work.

**You know it worked when:** the destination folder contains, among other
things, `Start.bat`, `ZomboidControlPanel.exe`, a `client\` folder, and a
`checksums.txt` file — not just one file.

**If this goes wrong:** if Explorer only shows a single `.exe` after
extracting, you extracted into a folder that already had one, or you're
looking at the zip's preview pane rather than the extracted copy — extract
again and note the destination folder this time.

---

## Phase 2: Run Start.bat

The zip's `ZomboidControlPanel.exe` isn't digitally signed — this project
doesn't code-sign its Windows builds — so Windows will challenge you twice
before it runs. Both are expected; neither means anything is actually wrong.

1. Double-click `Start.bat` (not the `.exe` directly — `Start.bat` is a
   supervisor that restarts the panel automatically if it ever crashes, and
   keeps a log of why).
2. **SmartScreen:** a blue **"Windows protected your PC"** screen appears
   first. Click **More info**, then **Run anyway**. This happens because the
   `.exe` is unsigned and new to your machine, not because anything is
   wrong with it.
3. **Antivirus:** some antivirus software flags freshly-downloaded, unsigned
   executables on sight — a common false-positive pattern for small,
   independently-built tools, not specific to this project. If yours
   quarantines or deletes `ZomboidControlPanel.exe`, restore it from
   quarantine and add an exclusion for the folder from Phase 1, then run
   `Start.bat` again.
4. A console window titled **"Zomboid Control Panel"** opens and starts
   printing status lines.

**You know it worked when:** the console shows, in order: `Starting Zomboid
Control Panel...`, a line like `Launching ZomboidControlPanel.exe`, an
ASCII banner box reading `Zomboid Control Panel` with a version number, and
finally a boxed **"Ready"** section listing a `Local:` URL
(`http://localhost:3001`). On Windows the panel also opens that URL in your
default browser automatically — you don't need to type it in yourself.

**If this goes wrong:**
- The console prints `ERROR: No ZomboidControlPanel binary found in this
  folder.` followed by `Expected: ZomboidControlPanel.exe` — you ran
  `Start.bat` from somewhere other than the folder you extracted in Phase 1,
  or moved `Start.bat` without its sibling `.exe`. Re-extract into one folder
  and run it from there.
- The console prints `Port <n> is in use and PORT is explicitly set;
  refusing to choose a different port.` — see
  [Phase 8](#phase-8-what-to-do-if-port-3001-is-already-taken) below. If you
  *haven't* set a `PORT` environment variable, you won't see this — the
  panel just quietly picks a different free port and tells you which one in
  the Ready box instead.
- The window flashes and closes instantly instead of showing the banner —
  open a normal Command Prompt, `cd` into the extracted folder, and run
  `Start.bat` from there so the error stays on screen instead of closing
  with the window.

Leave this console window open — closing it stops the panel. Phase 9 below
covers making it start on its own so you don't have to.

---

## Phase 3: Create the first-run admin account

Nobody owns this panel yet, and the console already told you so.

1. In the console from Phase 2, find the line starting with `SETUP TOKEN
   required to complete first-run setup:` followed by a long string of
   letters and numbers. Copy that string — treat it like a password; anyone
   who has it can create the admin account before you do.
2. In the browser tab the panel opened (or `http://localhost:3001` if it
   didn't), you'll see the setup screen with a **Setup Token** field, a
   **Panel Port** field (leave this at `3001` unless you already know you
   need something else), a username, and a password.
3. Paste the setup token, choose a username and password, confirm the
   password, and submit.

**You know it worked when:** the setup screen closes and you land on the
panel's dashboard, logged in.

**If this goes wrong:** `Invalid or missing setup token` means the token was
mistyped or the console line got scrolled out of view — scroll the console
up, or close and restart `Start.bat` to print a fresh copy of the *same*
token (it doesn't change on restart, only on first use, and only when
nobody has finished setup yet). If you've lost the console entirely, restart
the panel and the same token prints again.

---

## Phase 4: Find where Project Zomboid actually lives

Before you can add your server, you need two different folders, and mixing
them up is the single most common point of confusion on Windows:

- **The server install folder** — where the dedicated server's own program
  files live: `ProjectZomboid64.exe`/`ProjectZomboid32.exe` (or
  `StartServer64.bat` if you start it manually), and a `steamapps` marker if
  Steam put it there. If you installed the dedicated server through the
  Steam client, this is normally under `...\steamapps\common\Project Zomboid
  Dedicated Server\` in your Steam library — right-click **Project Zomboid
  Dedicated Server** in your Steam Library → **Manage** → **Browse local
  files** to jump straight there. If the panel's own setup wizard installed
  it for you via SteamCMD, it's whatever folder you typed into that wizard.

- **The Zomboid data folder** — where the server's `.ini`, save data, and
  logs actually live: **`%USERPROFILE%\Zomboid`**. This is *not* under
  `AppData` and is *not* inside the install folder above — press `Win+R`,
  type `%USERPROFILE%\Zomboid`, and press Enter to open it directly. Inside
  it you'll find a `Server\` subfolder holding one `.ini` per server you've
  ever run (named after the server, e.g. `Server\servertest.ini`) — that's
  the file Phase 5 below edits.

The panel asks for these in different places for different reasons: the
install folder when adding a server or running the install wizard (field
labeled **Server Install Path**, expecting the folder that contains
`StartServer64.bat`), and the data folder for anything touching saves, the
server `.ini`, backups, or mod files (field labeled **Zomboid Data Path**).
Typing one where the other belongs is the most common reason "Server Install
Path not configured" or a wizard step fails immediately.

**You know it worked when:** you can open both folders in File Explorer
without guessing, and you know which one has the `.exe`/`.bat` and which one
has the `.ini`/saves.

**If this goes wrong:** `%USERPROFILE%\Zomboid` doesn't exist yet if you've
never actually started the dedicated server once — start it directly (not
through the panel) at least once first, so PZ creates its own data folder
and default `.ini`, then come back to Phase 5.

---

## Phase 5: Enable RCON in the server .ini

The panel controls your PZ server over RCON — it won't connect without this.

1. Open `%USERPROFILE%\Zomboid\Server\<YourServerName>.ini` (from Phase 4)
   in Notepad.
2. Find (or add) these two lines:
   ```ini
   RCONPort=27015
   RCONPassword=choose-a-strong-password
   ```
   Use whatever port you actually want RCON on (27015 is PZ's own default)
   and a password only you know — this is not the same as your in-game admin
   password.
3. **Optional, only if you plan to use PanelBridge** (teleport, heal, god
   mode, weather control — the RCON-can't-reach features): also add
   ```ini
   DoLuaChecksum=false
   ```
   PanelBridge can be installed two ways, chosen later in **Settings →
   PanelBridge → How PanelBridge is installed** (see the
   [README](../../README.md#panelbridge-optional)). With the default,
   **installed by the panel**, this line has to stay: with the check on,
   players can't join. With **Steam Workshop** delivery (Build 42, server
   launched with Steam), keep it until that page confirms PanelBridge
   loaded from the Workshop; after that it can go back on. Workshop
   delivery can be chosen once a panel release carries the Workshop
   item's ID; until then the option reads *"Not available yet"*.
4. Save the file, then **restart the PZ server itself** (not the panel) —
   the game server only reads its `.ini` at startup.

**You know it worked when:** the `.ini` file has your `RCONPort` and
`RCONPassword` lines and the PZ server has been restarted since you saved
them. There's nothing to test yet from the panel side — that happens once
your server is actually added, in the next phase, since **Test Connection**
lives in that dialog.

**If this goes wrong:** if you can't find `%USERPROFILE%\Zomboid\Server\` at
all, or it's empty, go back to [Phase 4](#phase-4-find-where-project-zomboid-actually-lives) —
you likely haven't started the PZ server directly (outside the panel) even
once yet, which is what creates this folder and file in the first place.

---

## Phase 6: Add your server to the panel

The panel doesn't know your server exists yet — Phase 4 found the folders
and Phase 5 turned on RCON, but nothing you did in either one told the panel
about them. This phase connects the two.

1. In the panel's left sidebar, click **My Servers**.
2. Click **Add Existing Server** — not **Add Remote Server** or **Install
   New Server**, which are for different situations (a PZ server on a
   *different* machine — see [hosted.md](hosted.md) — or installing a brand
   new PZ server through the panel's own wizard, neither of which is what
   you just did in Phases 1-5). **Add Existing Server** opens already set to
   **Local Server** mode, which is correct here since PZ runs on this same
   PC.
3. You'll see two ways to fill in the rest of the form — pick whichever is
   easier for you, both end up in the same place:
   - **Auto Detect Servers** (the default view): paste the **Zomboid data
     folder** path from Phase 4 (`%USERPROFILE%\Zomboid`) into the scan box
     and click **Scan**. Matching servers appear as clickable cards — click
     yours to fill in the rest of the form automatically, including
     importing the RCON password straight from the `.ini` you just edited
     (you'll see **"leave blank to use it"** next to the password field —
     that's the import working, not a missing field).
   - **Manual Entry** (click the button in the top-right of that same box
     to switch to it): paste the **Zomboid data folder** path
     (`%USERPROFILE%\Zomboid`) into **Server Data Path**, and the **server
     install folder** path from Phase 4 into **Server Install Path**. If a
     matching `.ini` is found from the data path alone, the RCON fields
     fill in the same way as Auto Detect above; if not, type the
     `RCONPort`/`RCONPassword` from Phase 5 in yourself.
4. Give the server a display name if it isn't already filled in, then click
   **Test Connection** — this is your first real confirmation that Phase 5
   actually worked, not just that the form is filled in correctly.
5. Once **Test Connection** succeeds, click **Add Server**.

**You know it worked when:** the dialog closes and your server appears as a
card on the **My Servers** page, with its RCON indicator showing connected.

**If this goes wrong:** the same two `Test Connection` failure messages
apply here as anywhere else in the panel — `Unreachable: check host and
port` means the PZ server isn't listening there at all yet (not running,
wrong port, or something between the panel and PZ is blocking it — see
[Phase 7](#phase-7-open-windows-firewall-for-lan-access) if that step
applies to your setup); `Authentication failed: check RCON password` means
the port is right but the password doesn't match what's in the `.ini` —
retype it from Phase 5 rather than guessing. If **Auto Detect** finds
nothing, double-check you pasted the **data** folder (`%USERPROFILE%\Zomboid`),
not the install folder — the `.ini` files live under the data folder's
`Server\` subfolder, not next to `ProjectZomboid64.exe`.

**Test Connection succeeding here doesn't yet prove the panel can start
this server** — it only checks RCON against a server that's already
running (for example if you started it manually once, per Phase 4's own
advice). If your install folder — Steam's own default location,
`...\Program Files (x86)\Steam\steamapps\common\...`, qualifies — has a
space anywhere in it, or one of `&` `(` `)` `^`, clicking **Start** from
the panel can fail even though this step succeeded; see
[Server process exited immediately after starting](troubleshooting.md#server-process-exited-immediately-after-starting-code1-signalnone--startup-failed)
in troubleshooting.md.

---

## Phase 7: Open Windows Firewall for LAN access

Skip this phase if you only ever open `http://localhost:3001` on the same
PC the panel runs on. It's only needed so *other* devices on your network
can reach the panel.

1. The first time another device on your LAN tries to load the panel, or the
   first time the panel's port actually receives a connection from off this
   PC, Windows may show a **"Windows Defender Firewall has blocked some
   features of this app"** popup. Click **Allow access** — check at least
   **Private networks**, and **Public** too only if this PC is on a network
   you'd genuinely call public.
2. If that popup never appears (it doesn't always, and some AV suites
   suppress it) or you already clicked **Cancel** by mistake, add the rule
   by hand:
   - Open **Windows Defender Firewall with Advanced Security** (search for
     it in the Start menu).
   - **Inbound Rules** → **New Rule...** → **Port** → **TCP** → **Specific
     local ports:** `3001` → **Allow the connection** → check **Private**
     (and **Domain** if this PC is on one) → give it a name like "Zomboid
     Control Panel" → **Finish**.

This only opens the **panel's** port. Project Zomboid's own game and RCON
ports are separate and are the game server's concern, not this step's.

**You know it worked when:** the panel loads at
`http://<this-PC's-LAN-IP>:3001` from another device on the same network.
Find your LAN IP from the panel's own console — the Ready box prints a
`Network:` URL alongside `Local:` once it detects one.

**If this goes wrong:** a connection that just hangs and times out (rather
than being actively refused) almost always means this firewall step, not
the panel itself — recheck the inbound rule exists and is enabled for the
right network profile before looking anywhere else. If you're exposing this
beyond your own LAN, also see the `CORS_ORIGINS` note in the main
[README](../../README.md#remote-access) — the firewall alone doesn't cover
that case.

---

## Phase 8: What to do if port 3001 is already taken

You don't necessarily need to do anything — check what the console actually
says first.

- If you **haven't** set a `PORT` environment variable yourself (the default
  case for almost everyone following this guide), the panel already retries
  a few times and then picks a free port on its own, printing something like
  `Port 3001 remained unavailable after ... retries; selecting a free port
  automatically.` — check the **Ready** box in the console for whichever
  port it actually bound to, and use that instead of assuming 3001.
- If you **did** set `PORT` explicitly, the panel refuses to silently pick a
  different one and instead prints `Port <n> is in use and PORT is
  explicitly set; refusing to choose a different port.` In that case, find
  whatever's holding it:
  ```
  netstat -ano | findstr :3001
  ```
  The last column is a PID. Identify it with:
  ```
  tasklist /FI "PID eq <pid>"
  ```
  Then either stop that process or change your `PORT` value to a free one
  and restart `Start.bat`.

**You know it worked when:** the console's Ready box shows a `Local:` URL,
and it loads in a browser.

---

## Phase 9: Keep the panel running at boot (Task Scheduler)

This makes the panel start automatically when the PC boots, without you
needing to double-click `Start.bat` yourself every time.

1. Open **Task Scheduler** (search for it in the Start menu).
2. **Action** → **Create Task...** (not "Create Basic Task" — you want the
   full options).
3. **General** tab: give it a name (e.g. "Zomboid Control Panel"), and
   select **Run whether user is logged on or not** so it starts even before
   anyone signs in.
4. **Triggers** tab → **New...** → **Begin the task:** **At startup** →
   **OK**.
5. **Actions** tab → **New...** → **Action:** **Start a program** →
   **Program/script:** browse to `Start.bat` inside the folder from Phase 1
   → **OK**.
6. **Settings** tab: leave the defaults, but if **"Stop the task if it runs
   longer than..."** is checked, uncheck it — the panel is meant to run
   indefinitely, not for a fixed duration.
7. Click **OK**, and enter the Windows account password when prompted (only
   asked because of the "run whether logged on or not" option from step 3).

**You know it worked when:** right-click the task → **Run**, then check
`logs\supervisor.log` inside the extracted folder for a fresh `Supervisor v2
starting` / `Launching ZomboidControlPanel.exe` line, and confirm
`http://localhost:3001` loads without you having double-clicked anything.
The real test is a reboot: restart the PC and confirm the panel is already
reachable once Windows finishes starting, with no console window required to
stay open under your own login.

**If this goes wrong:** the task shows as run but the panel isn't reachable
— check `logs\supervisor.log` for what actually happened; a task running as
a different Windows account than the one who extracted the zip can hit
permission errors writing to that folder, which the log will show even
though Task Scheduler itself reports the task as having run successfully.
Run the task as the account that first started the panel (or as SYSTEM):
the panel's secret files in `data\` are readable only by that account,
SYSTEM and Administrators.

---

## Summary checklist

- [ ] Release zip extracted into its own folder (Phase 1)
- [ ] `Start.bat` runs, SmartScreen/antivirus prompts cleared, console shows
      the Ready box (Phase 2)
- [ ] Admin account created using the console's setup token (Phase 3)
- [ ] Server install folder and `%USERPROFILE%\Zomboid` data folder both
      located and not confused with each other (Phase 4)
- [ ] `RCONPort` / `RCONPassword` set in the server `.ini` and the PZ server
      restarted (Phase 5)
- [ ] Server added in the panel (**My Servers → Add Existing Server**) and
      **Test Connection** succeeds (Phase 6)
- [ ] Windows Firewall allows port 3001, only if accessed from another
      device (Phase 7)
- [ ] Port conflict, if any, resolved or the auto-picked port noted
      (Phase 8)
- [ ] Task Scheduler entry created and verified with an actual reboot,
      only if you want the panel running without a console open (Phase 9)
