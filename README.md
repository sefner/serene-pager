# Serene Pager

A tiny peer-to-peer paging app for a dental office LAN. Each operatory computer
runs the same app; they find each other automatically over the network and send
canned messages ("Doctor needed", "Room ready", …) that pop up with a sound on
the target station. **No server required** — nothing depends on the central
server, so it can go away without breaking paging.

## Features

- One-tap paging with canned messages (edit the list to suit the office).
- **Split pages** — send to one station, several at once, or Everyone.
- **Spoken pages** — the receiving computer says the message aloud (e.g.
  "Doctor needed. From Front Desk") in addition to a chime, for hands-busy rooms.
- **Acknowledge** — the sender sees a "✓ acknowledged" receipt.
- **Sent status + Cancel** — a "Sent" list shows each page as "awaiting ✓" until
  every recipient acknowledges; a Cancel button withdraws a page that's no
  longer needed and removes it from the recipient's screen.
- **Unattended stations** — incoming pages stack up on screen with the time
  received (and how long ago), so someone returning to a station sees every
  page that came in, not just the latest. Anything still showing is still
  wanted — cancelled pages remove themselves.
- **Do Not Disturb / snooze** — a station can go quiet for 30 min; pages still
  arrive silently in a "Received while snoozed" list, and other stations see 🔕
  next to that room. Auto-resumes so nobody stays muted all day.
- Lives in the system tray, auto-starts on Windows login, always-on-top alerts.
- No patient data in messages (room/role only) → clear of HIPAA data handling.

## How it works

- Every station broadcasts a small "hello" on UDP port **41234** every few
  seconds, so each computer keeps a live roster of who's online.
- Sending a page broadcasts a small UDP packet; only the targeted station (or
  "Everyone") shows it. The receiver can **Acknowledge**, which sends a receipt
  back to the sender.
- Pages, acks, and cancels are each broadcast 3× over ~1 second and deduped by
  id on arrival, so a single dropped packet can't silently lose a page.
- Station name is stored per-computer; auto-start on Windows login is enabled on
  first run.

There is intentionally **no patient data** in messages (room/role only), which
keeps it clear of HIPAA data-handling concerns.

## Run it (development)

```bash
npm install
npm start
```

Launch it on two computers on the same LAN, give each a station name, and page
between them. (On a single dev machine you can only see the roster/sound loop;
real paging needs two machines because a station never pages itself.)

## Build a Windows installer

```bash
npm run dist
```

This produces an `.exe` installer under `dist/`. Copy it to each of the 6
operatory computers and run it once. **Use the `Serene Pager Setup x.y.z.exe`
installer, not the zip** — only installed copies auto-update.

## Shipping an update (no office visit needed)

Installed stations check the GitHub releases of `sefner/serene-pager` on
launch and every 4 hours, download new versions in the background, and install
them silently — right away if the machine was just turned on, otherwise at
3 AM or on quit. Hover the tray icon to see which version a station is running.

One-time setup: make the `sefner/serene-pager` repo **public** (stations
download release files anonymously; a private repo would need a token baked
into every machine).

Then for every release:

```bash
# 1. bump "version" in package.json (e.g. 0.1.0 -> 0.2.0), commit
# 2. tag and push:
git tag v0.2.0
git push && git push --tags
```

Pushing the tag triggers the GitHub Actions workflow
(`.github/workflows/release.yml`), which builds the installer on a Windows
runner and publishes the release; every station picks it up automatically
within a few hours. Don't delete old releases the moment a new one is out — a
station mid-download could be fetching them.

(Local alternative: `GH_TOKEN=... npm run release` builds and publishes from
this machine, but building the Windows installer from Linux/WSL requires
`wine` — the Actions route avoids that.)

## Deployment notes (important)

1. **Windows Firewall** will prompt on first launch — click **Allow access** on
   Private networks. To avoid the prompt on each machine, IT can pre-add a rule
   allowing `Serene Pager` on UDP 41234.
2. All operatory computers must be on the **same subnet/VLAN** for broadcast
   discovery to work. (Standard for a small office LAN.)
3. Auto-start on login is enabled automatically; toggle it from the tray icon
   menu ("Start with Windows").
4. Closing the window hides it to the system tray so the station keeps receiving
   pages. Use the tray menu → **Quit** to fully exit.

## Customizing

- Canned messages: edit `MESSAGES` in `ui/renderer.js`.
- Suggested station names: edit `PRESETS` in `ui/renderer.js`.
- UDP port: `PORT` in `main.js`.
