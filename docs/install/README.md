# Install Guides

One guide per setup. Each stands alone — pick yours and start there, you
don't need to read the others first.

- **[windows.md](windows.md)** — Running the panel directly on a Windows PC
  or Windows server: extract and run, no Docker. Covers RCON setup, opening
  Windows Firewall, what to do if port 3001 is taken, and keeping the panel
  running at boot via Task Scheduler.
- **[linux.md](linux.md)** — Running the panel directly on Linux (a VPS, a
  home server): extract and run, no Docker. Covers the glibc floor, running
  as a non-root user, installing the bundled systemd service (including the
  `ReadWritePaths` trap), SteamCMD's 32-bit library requirements, and
  opening the firewall with ufw or firewalld.
- **[managed-game-services.md](managed-game-services.md)** — Optional
  per-server systemd or OpenRC isolation so panel restarts and updates do not
  own the game-server process.
- **[docker.md](docker.md)** — Docker or Unraid, in whichever of four
  configurations matches where Project Zomboid itself already runs: a single
  all-in-one container, a panel bound to an existing PZ install, a
  panel-only container talking to a remote server, or Unraid specifically.
- **[troubleshooting.md](troubleshooting.md)** — Something didn't work.
  Organized by what's actually on your screen, not by which guide you
  followed or which subsystem you suspect — start here regardless of which
  path above you took.
- **[hosted.md](hosted.md)** — You rent a Project Zomboid server from a
  host (Indifferent Broccoli and similar) instead of running it yourself:
  no shell, no Docker, no systemd on that machine. Covers what the panel
  can and can't do for a server it doesn't own the process of, why
  PanelBridge needs SFTP specifically (not FTP), and installing the panel
  itself on a separate machine you do control first.

Not covered here: macOS (Docker Desktop or OrbStack) is short enough to
live in the main [README](../../README.md#macos) instead of getting its
own file.

For anything past initial install — PanelBridge, updates, remote access, the
full feature list — see the main [README.md](../../README.md).
