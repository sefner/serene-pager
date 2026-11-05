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
  next to that room. Auto-resumes so nobody stays muted all day. When the
  snooze ends, un-cancelled snoozed pages pop up as live alerts (with their
  original arrival times) so they still get acknowledged — snooze defers
  pages, it never swallows them.
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

## Android stations (android/, added 2026-11-05)

An Android tablet can be a station too. It speaks the same UDP protocol on port 41234, so Windows and Android stations
page each other directly: no server, no internet. The screen is this repo's own `ui/` folder, packed into the app
unchanged; `android/app/src/main/assets/android-shim.js` gives it the `window.pager` functions that `preload.js`
gives it on Windows. A change to `ui/` ships to both.

What the Android side adds, because a tablet sleeps:
- a foreground service (`PagerService.kt`) that keeps listening with the screen off (with a Wi-Fi multicast lock,
  without which Android drops broadcast packets while asleep) and starts again after a restart (`BootReceiver.kt`);
- a full-screen alert that wakes the tablet and shows the page over the lock screen, with sound;
- Android's own text-to-speech for station names without a pre-recorded clip (WebView can't speak).

The protocol logic (`PagerCore.kt`) has no Android in it and is tested against the Windows app's exact packets:
`cd android && ./gradlew testDebugUnitTest`.

### Build
Needs JDK 17 and the Android SDK (on Steve's WSL machine: `~/.local/android`):
```bash
cd android
export JAVA_HOME=~/.local/android/jdk-17.0.21+9 ANDROID_HOME=~/.local/android/sdk
./gradlew assembleRelease      # -> app/build/outputs/apk/release/app-release.apk
```
Signing reads `android/keystore.properties` (not in git) pointing at `serene-pager-release.jks`. **Keep that key:
every update must be signed with it**, or each tablet has to uninstall and reinstall. Bump `versionCode` for each update.

### Install on a tablet (once)
1. Copy `app-release.apk` to the tablet (USB, or email it to yourself) and open it; allow "install unknown apps" for
   whichever app opened it.
2. Open Serene Pager and pick the station name.
3. Allow notifications, allow it to run in the background ("Don't optimize" / "Unrestricted" battery), and allow
   full-screen alerts if asked.
4. Keep the tablet on the office Wi-Fi (not guest Wi-Fi, which hides devices from each other) and plugged in.
