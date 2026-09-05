# Docker Install Guide

This repo ships **three** Docker paths. They are not interchangeable — each
assumes a different starting point. Read the table below first; it takes one
read to know which walkthrough is yours.

If you get lost partway through, jump back to the table — nothing here
assumes you've read the others.

## Which path is mine?

| What you already have | Use this path |
| --- | --- |
| Nothing running yet. You want one container that installs and runs Project Zomboid **and** the panel. | [All-in-one](#path-a-all-in-one) — the flagship, most-complete path |
| Project Zomboid already running on **this same host** (systemd, screen, tmux, another container) and you want the panel to edit its config files, take local backups, or use PanelBridge. | [docker-compose.yml](#path-b-docker-composeyml-bind-mounts) — bind mounts, full file access |
| Project Zomboid running **somewhere else** (another machine, a separate container, or a hosting provider) and you just want the panel talking to it over RCON — no shared filesystem needed. | [docker-compose.install.yml](#path-c-docker-composeinstallyml-panel-only) — fastest, named volumes only |
| **Unraid**, with Project Zomboid already running in its own container/template (for example an Indifferent Broccoli or community PZ template). | [Unraid template](#path-d-unraid) — panel only, points at your existing PZ container |
| macOS | There's no native macOS binary. Use [Path C](#path-c-docker-composeinstallyml-panel-only) with Docker Desktop or OrbStack. |

Every path ends with the same web UI at `http://localhost:3001` — only how
Project Zomboid gets there differs.

---

## Path A: All-in-one

**What it is:** one container running the panel, SteamCMD, and the Project
Zomboid dedicated server together. This is what the maintainer actually runs
in production, and the most complete path — pick this if you're starting
from nothing.

### Phase 1 — Prerequisites

1. A Linux host (or a Linux VM), **amd64/x86_64**, with **Docker Engine**
   installed and running. You do **not** need the Docker Compose plugin on
   the host — the installer runs Compose inside its own controller
   container.
2. `curl` and `tar` available on the host.

The installer checks all of this itself before it does anything else —
missing command, unreachable Docker daemon, or a non-amd64 host each stop it
immediately with a plain-English message, rather than failing confusingly
partway through.

**You know it worked when:** `docker info` runs without an error. If it
prints "permission denied", your user isn't in the `docker` group yet (or you
need `sudo` in front of the commands below).

### Phase 2 — Run the installer

3. Run:
   ```sh
   curl -fsSL https://raw.githubusercontent.com/fpsacha/zomboid-control-panel/main/docker/all-in-one/bootstrap.sh | sh
   ```
   This resolves the latest release, creates its state under
   `~/.local/state/zomboid-panel/` (override with the `PANEL_HOME` or
   `BUILD_ROOT` environment variables if you want it elsewhere), generates a
   random updater token, detects the host's LAN address, and starts the
   stack.

   To install a specific version instead of the latest release, pass it as
   an argument:
   ```sh
   curl -fsSL https://raw.githubusercontent.com/fpsacha/zomboid-control-panel/main/docker/all-in-one/bootstrap.sh | sh -s -- 1.2.6
   ```

   For the panel and updater images, it pulls the exact release-tagged image
   from GHCR first; only if that specific tag isn't published yet does it
   fall back to building the image locally from the downloaded release
   source — so a normal run doesn't compile anything on your host.

**You know it worked when:** the script's last line is `All-in-one
installation is ready.` followed by the panel URL and a note that the PZ
ports are published automatically. If it instead prints `Could not determine
a valid release version`, the GitHub API call failed (rate-limited or
offline) — pass a version explicitly as shown above.

### Phase 3 — Wait for first boot

4. On first start, the container also downloads Project Zomboid itself
   through SteamCMD, which can take several minutes depending on your
   connection. The installer waits for this on its own — polling the
   panel's health check for up to 15 minutes — so you don't need to watch
   it, but you can:
   ```sh
   docker logs -f zomboid-panel
   ```
   Look for `[entrypoint] No PZ install found in /pz-server; installing as
   steam...` followed by SteamCMD's own output. A second start (after an
   update or restart) skips this — you'll see `[entrypoint] Existing PZ
   install found in /pz-server.` instead. If the container stops or the
   health check never turns green within 15 minutes, the installer prints
   the last 40 lines of `docker logs` itself and exits — you don't need to
   go dig for them.

**You know it worked when:** `docker ps` lists both `zomboid-panel` and
`zomboid-panel-updater` as `Up`, and `zomboid-panel` eventually shows
`(healthy)`. If it never leaves `(starting)`, check the logs from step 4 —
SteamCMD usually hasn't finished yet.

### Phase 4 — First login

5. Open `http://localhost:3001` (or whatever origin you set — see
   [CORS_ORIGINS](#cors_origins-when-accessed-from-anywhere-other-than-localhost)
   below if that's not `localhost`). You'll see a setup screen asking for a
   **Setup Token**.
6. Get that token by watching the same logs from Phase 3:
   ```sh
   docker logs zomboid-panel | grep "SETUP TOKEN"
   ```
   Copy the long string after `SETUP TOKEN required to complete first-run
   setup:` — treat it like a password; anyone who has it can create the
   admin account before you do. Paste it into the setup screen, choose a
   username and password, confirm the password, and submit.
7. Project Zomboid, RCON, and the PanelBridge mod are all local to this
   container, so the setup wizard should find them without extra
   configuration. If RCON shows disconnected, open **Settings** and confirm
   the RCON password matches your server `.ini` (see [README —
   Setup](../../README.md#setup)).

**You know it worked when:** the dashboard shows the server status card
instead of a setup prompt, and RCON shows connected.

### Updating

After the first install, use the panel's **Settings** page to apply a newer
release: it saves and stops Project Zomboid through RCON, downloads the
tagged source, rebuilds the panel image, recreates only the panel service,
and waits for its health check. A failed rollout restores the previous
source and image automatically — you don't need to intervene.

### Notes specific to this path

- Panel state, PZ install, and PZ save data all live in **named Docker
  volumes** (`panel-data`, `panel-logs`, `pz-server`, `zomboid-data`), not
  bind mounts. You never need to set `PUID`/`PGID` for this path — see
  [the PUID/PGID section](#puidpgid-on-bind-mounted-pz-folders) for why.
- The update controller (`zomboid-panel-updater`) mounts the host's Docker
  socket so it can rebuild and recreate the panel container — that mount is
  **host-root-equivalent access**, not just container-level access: anyone
  who can reach that container's HTTP endpoint can run arbitrary containers
  on the Docker host itself, not only affect the panel. It is protected by
  two things, both load-bearing: the token in `.env` (`PANEL_DOCKER_UPDATER_TOKEN`,
  compared with a constant-time check — there is no default, `docker compose`
  refuses to start without one), and the fact that its port is **never**
  published to the host — it is reachable only over the internal Compose
  network, by container name. Do not add a `ports:` mapping for
  `zomboid-panel-updater` to this stack; doing so would expose that
  host-root-equivalent endpoint to the network the port is bound on.
- The PZ game ports (`16261/udp`, `16262/udp`) are published automatically
  by the stack — there's nothing to add to Compose by hand for this path.
- Config lives at `<state dir>/build/ctx/.env` (`~/.local/state/zomboid-panel/build/ctx/.env`
  by default). The installer sets `CORS_ORIGINS` there itself on first run —
  `http://localhost:3001` plus your detected LAN address — so LAN access
  usually needs no extra configuration. For a reverse proxy or public
  hostname, edit `CORS_ORIGINS` (and `TRUST_PROXY`) in that file, then
  re-run the curl command from step 3 — it reapplies the stack but never
  overwrites an `.env` that already exists, so your edit sticks.

---

## Path B: docker-compose.yml (bind mounts)

**What it is:** the panel only, with commented-out bind-mount examples for a
Project Zomboid install that already exists on this host or is reachable
over a network share. Use this when you need the panel to edit PZ's config
files, take local backups, or use PanelBridge, and PZ isn't in the same
container as the panel.

### Phase 1 — Prerequisites

1. Docker Engine **and** the Docker Compose plugin (`docker compose version`
   should print a version).
2. Project Zomboid already installed somewhere the panel can reach — on this
   host, or over RCON to another machine/container.
3. If bind-mounting PZ folders on this host: know the numeric user/group
   that owns them. Run `id -u` and `id -g` as the user PZ runs as.

**You know it worked when:** `docker compose version` prints without error.

### Phase 2 — Download the files

4. ```sh
   mkdir -p ~/zomboid-panel && cd ~/zomboid-panel
   curl -O https://raw.githubusercontent.com/fpsacha/zomboid-control-panel/main/docker-compose.yml
   curl -O https://raw.githubusercontent.com/fpsacha/zomboid-control-panel/main/.env.example
   mv .env.example .env
   ```

**You know it worked when:** `ls` in that directory shows both
`docker-compose.yml` and `.env`.

### Phase 3 — Edit before first start

5. Open `.env` and set `PUID`/`PGID` to the values from step 3 (see
   [PUID/PGID](#puidpgid-on-bind-mounted-pz-folders) below for why this
   matters).
6. Open `docker-compose.yml` and uncomment the volume lines for your
   topology (PZ on this host, or PZ reachable over NFS/SMB) — the file has
   both examples annotated inline. Point them at your real PZ install and
   `Zomboid` data folders.
7. If the panel will be reached from anywhere other than `localhost` (a
   reverse proxy, a domain name), also see
   [CORS_ORIGINS](#cors_origins-when-accessed-from-anywhere-other-than-localhost)
   below before continuing.

### Optional: let the panel control a PZ container

Path B can start, stop, and restart a Project Zomboid container on the same
Docker host. This is deliberately opt-in: mounting `docker.sock` gives the
panel control over every container on that host.

Before `docker compose up -d`:

1. In `.env`, set:
   ```dotenv
   PANEL_DOCKER_CONTROL_ENABLED=true
   DOCKER_GID=999
   ```
   Replace `999` with the numeric group that owns the host socket:
   `stat -c '%g' /var/run/docker.sock`.
2. In `docker-compose.yml`, uncomment the Docker socket volume and the
   `group_add` block. The supplementary group is required when the panel's
   `PUID`/`PGID` is not already allowed to read and write the socket.
3. Add the management label to the PZ container. For Compose, add this to
   the PZ service and recreate it:
   ```yaml
   labels:
     zomboid-panel.managed: "true"
   ```
   For an existing container, the equivalent one-time command is:
   ```sh
   docker update --label-add zomboid-panel.managed=true <pz-container>
   ```
4. In **Servers**, put the PZ container's name or ID in **Docker container**
   on the server profile. Use the Compose service/container name when the
   panel and PZ share a Docker network.

**You know it worked when:** the Docker page lists the labeled container,
the server profile shows its container name, and Start/Stop uses the
container lifecycle instead of sending RCON `quit` to PID 1. If the Docker
page says the daemon is unavailable, check the socket mount and the numeric
socket group before changing the PZ configuration.

**You know it worked when:** rereading the volumes block, the left side of
each `:` is a real path on this machine, not a placeholder.

### Phase 4 — Start it

8. ```sh
   docker compose up -d
   ```

**You know it worked when:** `docker compose ps` shows `zomboid-panel` as
`Up (healthy)`, and `curl -s http://localhost:3001/api/health` returns
`{"status":"ok"...}` (exact fields may vary; a 200 response is what matters).

### Phase 5 — First login

9. Open `http://localhost:3001`. You'll see a setup screen asking for a
   **Setup Token** — get it from the container's logs:
   ```sh
   docker compose logs zomboid-panel | grep "SETUP TOKEN"
   ```
   Copy the long string after `SETUP TOKEN required to complete first-run
   setup:` and paste it into the setup screen, then choose a username and
   password and submit.
10. In **Settings**, set the server install path and Zomboid data path to
    the **container-side** paths from your volumes block (for example
    `/pz-server` and `/zomboid`), never the host paths on the left side of
    the `:`.
11. Configure RCON (host, port, password from your server `.ini`) — see
    [README — Setup](../../README.md#setup). If Project Zomboid runs in a
    **separate container** rather than on the host directly, don't use
    `127.0.0.1` as the RCON host — inside the panel container that address
    means the panel container itself, and the connection fails in a way
    that looks like a bad RCON password or port rather than a topology
    mistake. Put both containers on the same user-defined Docker network,
    then enter the PZ container's Compose **service name** (for example
    `pzserver`) as the RCON host instead.

**You know it worked when:** the dashboard shows the server status card and
RCON shows connected.

### Notes specific to this path

- **Published image vs. build from source:** `docker-compose.yml` already
  has both `image:` and `build:` set — there's nothing to edit either way.
  `docker compose up -d` tries to pull `ghcr.io/fpsacha/zomboid-panel:latest`
  first; if that fails (no tagged release yet, or a private fork without
  GHCR access), it builds from source automatically and tags the result the
  same, so later `up -d` runs won't try to pull again. Each tagged release
  also publishes a version-pinned image with a matching name (for example
  `ghcr.io/fpsacha/zomboid-panel:1.2.4` — no `v` prefix, unlike the git tag
  it's built from), if you'd rather pin a version than track `:latest`.

---

## Path C: docker-compose.install.yml (panel only)

**What it is:** the fastest path to a running panel — named volumes only, no
bind mounts, no `PUID`/`PGID` to figure out. Use this when Project Zomboid
runs somewhere the panel doesn't need file access to (another machine, a
separate container, a hosting provider), or you just want to look at the
panel before committing to a full setup.

### Phase 1 — Prerequisites

1. Docker Engine and the Docker Compose plugin.

### Phase 2 — Start it

2. ```sh
   curl -O https://raw.githubusercontent.com/fpsacha/zomboid-control-panel/main/docker-compose.install.yml
   docker compose -f docker-compose.install.yml up -d
   ```
   `pull_policy: always` means every `up -d` you run later fetches the
   newest published image — this file has no version pinning of its own.

**You know it worked when:** `docker compose -f docker-compose.install.yml
ps` shows `zomboid-panel` as `Up`.

### Phase 3 — First login

3. Open `http://localhost:3001`. You'll see a setup screen asking for a
   **Setup Token** — get it from the container's logs:
   ```sh
   docker compose -f docker-compose.install.yml logs zomboid-panel | grep "SETUP TOKEN"
   ```
   Copy the long string after `SETUP TOKEN required to complete first-run
   setup:` and paste it into the setup screen, then choose a username and
   password and submit.
4. Open **Servers** and add your Project Zomboid server as a **remote
   server** using its RCON host, port, and password — this path has no
   shared filesystem, so PanelBridge needs SFTP (Settings → PanelBridge →
   Remote connection) if you want it, rather than a shared folder.

**You know it worked when:** the server shows as connected in **Servers**.

---

## Path D: Unraid

**What it is:** a Community Applications template that runs the panel
**only**, alongside a Project Zomboid container you already have (for
example from Indifferent Broccoli or a community PZ template). It does not
install or run Project Zomboid itself.

### Phase 1 — Prerequisites

1. An existing PZ container/template on the same Unraid box, with its host
   paths for the PZ install and PZ config/save data noted down.

### Phase 2 — Import and configure

2. In Unraid's **Docker** tab, add the container from template:
   `https://raw.githubusercontent.com/fpsacha/zomboid-control-panel/main/docker/unraid/zomboid-panel.xml`
   (or search "Zomboid Control Panel" if it's listed in Community
   Applications).
3. Set these four path mappings — the panel's own two are pre-filled, the
   PZ two must be changed to match your PZ container's template:

   | Field | Target | Set it to |
   | --- | --- | --- |
   | Panel data | `/app/data` | Leave as `/mnt/user/appdata/zomboid-panel/data` (or your preference) — this is the panel's own database, not PZ's |
   | Panel logs | `/app/logs` | Leave as `/mnt/user/appdata/zomboid-panel/logs` (or your preference) |
   | PZ install | `/pz-server` | The **install** path from your existing PZ container's template |
   | PZ user data | `/zomboid` | The **config/saves** path from your existing PZ container's template |

4. Set `PUID`/`PGID` to match the owner used by your PZ container (Unraid
   defaults `99`/`100` are pre-filled — change them if your PZ container
   uses different values).
5. Set `RCON host`: the PZ container's name if both are on the same
   user-defined Docker network, otherwise its fixed LAN address. **Never**
   `127.0.0.1` — inside the panel container that means the panel itself, not
   your PZ container. Set `RCON port` and `RCON password` to match your PZ
   server's `.ini`.
6. Apply.

**You know it worked when:** the container shows started (green) in the
Docker tab, and clicking its icon opens the panel WebUI on the port you
configured.

### Phase 3 — First login

7. Open the WebUI. You'll see a setup screen asking for a **Setup Token** —
   get it from the container's logs: in Unraid's **Docker** tab, click the
   panel container's icon → **Logs**, and find the line starting `SETUP
   TOKEN required to complete first-run setup:`. Copy the long string after
   it and paste it into the setup screen, then choose a username and
   password and submit.
8. In **Settings**, set the paths to the **container-side** values —
   `/pz-server` and `/zomboid` — never the `/mnt/...` host paths from step 3.
9. If your PZ container doesn't expose `/zomboid` to the panel at all, use
   **Settings → PanelBridge → Remote server via SFTP** instead of a shared
   folder.

**You know it worked when:** the dashboard shows the server status card and
RCON shows connected. By default, the panel can monitor and administer the
game through RCON, but it does not start, stop, or auto-update a PZ container
owned by Unraid.

### Optional: let the panel control the Unraid PZ container

Only enable this when you want the panel to own the container lifecycle
instead of Unraid. In the Unraid template editor:

1. Add a bind mount from the host `/var/run/docker.sock` to the container
   `/var/run/docker.sock` with read/write access.
2. Add the environment variable `PANEL_DOCKER_CONTROL_ENABLED=true`.
3. Add the Docker socket's numeric group to the container's **Extra
   Parameters**, for example `--group-add=281`. Find the real value on the
   Unraid host with `stat -c '%g' /var/run/docker.sock`; do not assume the
   example value.
4. Add the label `zomboid-panel.managed=true` to the existing PZ container
   and put that container's name in the panel's **Docker container** field.

The Docker socket is equivalent to host-level container control, so leave
this disabled unless the panel is trusted. If it is enabled but the Docker
page still reports the daemon as unavailable, check the socket mount and
the supplementary group first.

---

## The two things that actually bite

### PUID/PGID on bind-mounted PZ folders

This applies to **Path B** and **Path D** — anywhere the panel bind-mounts a
PZ folder that already exists on the host, owned by a specific Linux
user/group. It does **not** apply to **Path A** (all-in-one uses named
volumes it owns itself, always as UID/GID `1000` internally) or **Path C**
(no PZ mounts at all).

The container image runs as root by default and re-owns exactly two
directories to a numeric UID/GID: `/app/data` and `/app/logs` (its own
state). It never touches the ownership of your PZ install or save mounts.
If `PUID`/`PGID` don't match the actual owner of those bind-mounted PZ
folders, one of two things happens:

- **The panel's own directories are wrong** (rare) — you set `PUID`/`PGID`
  to something other than the account you plan to use, and Docker-managed
  volumes come up owned by that value instead. Docker manages
  `panel-data`/`panel-logs` volumes itself, so this is usually only visible
  if you replaced them with host bind mounts.
- **PZ config edits or PanelBridge file access fail with permission
  errors** (the actual failure mode) — the panel process is running as a
  UID/GID that doesn't have write access to your real PZ folders, because
  `PUID`/`PGID` didn't match the account that owns them on the host.

Fix it:
```sh
id -u   # your PUID
id -g   # your PGID
```
Put those values in `.env`, then restart:
```sh
docker compose up -d
```
No rebuild needed — the published image applies `PUID`/`PGID` at container
start, not at build time.

One exception: if the container is launched with a UID already pinned (for
example a Kubernetes pod with `runAsUser`/`runAsGroup`/`runAsNonRoot:
true`), it has no permission to `chown` anything and skips the step
entirely — in that case `PUID`/`PGID` are ignored, and `/app/data` and
`/app/logs` must already be writable by whatever UID the pod was given.

### CORS_ORIGINS when accessed from anywhere other than localhost

The panel auto-allows any local or LAN address (`localhost`, `127.0.0.1`,
`192.168.x.x`, `10.x.x.x`, and similar private ranges) without any
configuration. You only need `CORS_ORIGINS` when the browser reaches the
panel through something that **isn't** a private address — a public
hostname behind a reverse proxy, most commonly.

Symptom if you skip this: the page loads, but every API call in the browser
console fails and the panel logs `Origin blocked by panel CORS policy`. This
is a browser-side same-origin check — it isn't about the container being
unreachable, so `curl` from the panel host will still work fine even when a
browser is blocked.

Fix it — set the **exact** origin the browser uses (scheme, host, and port
if non-default), comma-separated if there's more than one. Once you're
logged in, you can also manage allowed origins from **Settings → Remote
Access** instead — the environment variable exists specifically to solve the
chicken-and-egg problem of not being able to reach Settings if CORS is
already blocking you. **Where you set it, and how you apply it, is different
per path** — the variable name is the same everywhere, but only Path A and
Path D actually wire it up out of the box:

- **Path A (all-in-one):** already wired. It lives in a different file —
  `<state dir>/build/ctx/.env` (default:
  `~/.local/state/zomboid-panel/build/ctx/.env`) — and defaults to
  `http://localhost:3001` plus your detected LAN address when the installer
  first creates it. Edit it there, then re-run the bootstrap command to
  apply the change (see [Path A's notes](#notes-specific-to-this-path)
  above).
- **Path B (docker-compose.yml):** **not** read from `.env` — the
  `CORS_ORIGINS` line in `docker-compose.yml`'s `environment:` block is
  commented out and literal, not `${CORS_ORIGINS}`-interpolated, so setting
  it in `.env` alone does nothing here. Uncomment and edit the line directly
  in `docker-compose.yml`:
  ```yaml
  environment:
    - CORS_ORIGINS=https://panel.example.com
  ```
  then apply it:
  ```sh
  docker compose up -d
  ```
- **Path C (docker-compose.install.yml):** **no wiring for this at all** —
  there's no `CORS_ORIGINS` line, commented or otherwise, anywhere in the
  file. If you need the panel reachable through a reverse proxy or public
  hostname on this path, add the line yourself before starting the stack:
  ```yaml
  environment:
    NODE_ENV: production
    TRUST_PROXY: ${TRUST_PROXY:-false}
    CORS_ORIGINS: https://panel.example.com
  ```
  This works — the panel reads `CORS_ORIGINS` from its process environment
  regardless of which compose file set it — but you're editing in a value
  the file doesn't otherwise expose. If you'd rather not hand-edit the
  compose file, use [Path B](#path-b-docker-composeyml-bind-mounts) instead,
  which has the field ready to uncomment.
- **Path D (Unraid):** already wired — it's the **CORS origins** field under
  the template's advanced settings (blank by default, LAN-only). Expand
  "Show more settings" if you don't see it.

Restart (or recreate, for Path B/C) the panel container for the change to
take effect.

## Automating first-run setup

Every path above has you grab the **Setup Token** by grepping it out of the
container logs after first start. If you're scripting the deployment (CI,
Ansible, a provisioning tool) and nothing is watching those logs, set
`SETUP_TOKEN` to a value you choose *before* the first start instead — the
panel uses it directly and skips generating and printing its own:

```yaml
environment:
  SETUP_TOKEN: a-value-only-your-script-knows
```

Treat it exactly like the printed token would be — whoever presents it
first creates the admin account. It only matters before that first account
exists; once setup is complete, the panel ignores it.
