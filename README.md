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
operatory computers and run it once.

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
