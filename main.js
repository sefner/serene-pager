'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');

// ---- Constants -----------------------------------------------------------
const PORT = 41234;              // UDP port every station listens/broadcasts on
const HEARTBEAT_MS = 3000;       // how often we announce ourselves
const ROSTER_TIMEOUT_MS = 10000; // drop a station from the roster after this silence
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

// Test/profile mode: `--profile="Op 2"` (or PAGER_PROFILE env var) lets you run
// several independent copies on ONE computer for testing — each gets its own
// name, its own saved settings, and its own window. Normal installs leave this
// unset and behave as a single per-machine station.
const PROFILE = (() => {
  const arg = process.argv.find((a) => a.startsWith('--profile='));
  if (arg) return arg.slice('--profile='.length);
  return process.env.PAGER_PROFILE || null;
})();

// ---- State ---------------------------------------------------------------
let config = {};                 // { name }
let mainWindow = null;
let tray = null;
let socket = null;
let dndUntil = 0;                 // epoch ms until which Do-Not-Disturb is active (0 = off)
const roster = new Map();        // name -> { name, address, last, dnd }
const seenPages = new Set();     // page ids we've already handled (dedupe broadcasts)
app.isQuitting = false;

function isDnd() { return dndUntil > Date.now(); }

// ---- Config persistence --------------------------------------------------
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); }
  catch { return {}; }
}
function saveConfig() {
  try { fs.writeFileSync(configPath(), JSON.stringify(config, null, 2)); }
  catch (e) { console.error('saveConfig failed', e); }
}

// ---- Networking ----------------------------------------------------------
// Compute the directed-broadcast address for each active IPv4 interface so
// pages reach every station on the LAN without needing a server.
function broadcastAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) {
        const ip = i.address.split('.').map(Number);
        const mask = i.netmask.split('.').map(Number);
        const bc = ip.map((o, idx) => (o & mask[idx]) | (~mask[idx] & 255));
        out.push(bc.join('.'));
      }
    }
  }
  if (out.length === 0) out.push('255.255.255.255');
  return out;
}

function sendPacket(obj) {
  if (!socket) return;
  const buf = Buffer.from(JSON.stringify(obj));
  for (const addr of broadcastAddresses()) {
    socket.send(buf, 0, buf.length, PORT, addr, (err) => {
      if (err) console.error('send error', addr, err.message);
    });
  }
}

function startNetwork() {
  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', (err) => console.error('socket error', err));
  socket.on('message', onMessage);
  socket.bind(PORT, () => {
    try { socket.setBroadcast(true); } catch (e) { console.error(e); }
    sendHeartbeat();
  });
  setInterval(sendHeartbeat, HEARTBEAT_MS);
  setInterval(pruneRoster, HEARTBEAT_MS);
}

function sendHeartbeat() {
  if (config.name) sendPacket({ type: 'hello', name: config.name, dnd: isDnd() });
}

function pruneRoster() {
  const now = Date.now();
  let changed = false;
  for (const [name, entry] of roster) {
    if (now - entry.last > ROSTER_TIMEOUT_MS) { roster.delete(name); changed = true; }
  }
  if (changed) pushRoster();
}

function rosterList() {
  return [...roster.values()]
    .map((e) => ({ name: e.name, dnd: !!e.dnd }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function pushRoster() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('roster', rosterList());
  }
}

function onMessage(buf, rinfo) {
  let m;
  try { m = JSON.parse(buf.toString()); } catch { return; }
  if (!m || typeof m.type !== 'string') return;

  switch (m.type) {
    case 'hello': {
      if (!m.name || m.name === config.name) return; // ignore self
      const prev = roster.get(m.name);
      const changed = !prev || prev.dnd !== !!m.dnd;
      roster.set(m.name, { name: m.name, address: rinfo.address, last: Date.now(), dnd: !!m.dnd });
      if (changed) pushRoster();
      break;
    }
    case 'page': {
      if (m.from === config.name) return;             // don't page myself
      if (seenPages.has(m.id)) return;                // dedupe repeated broadcasts
      // `to` is 'ALL', a single station name, or an array of names.
      const forMe = m.to === 'ALL'
        || m.to === config.name
        || (Array.isArray(m.to) && m.to.includes(config.name));
      if (forMe) {
        seenPages.add(m.id);
        handleIncoming(m);
      }
      break;
    }
    case 'ack': {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ack', m);
      break;
    }
  }
}

// ---- Incoming page presentation -----------------------------------------
function handleIncoming(m) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const silent = isDnd();
  mainWindow.webContents.send('incoming', { ...m, silent });
  if (silent) return; // Do-Not-Disturb: log it quietly, no pop-up / sound / focus-steal
  if (mainWindow.isMinimized()) mainWindow.restore(); // un-minimize reliably (show() alone isn't enough on Windows)
  mainWindow.show();                                  // un-hide from the tray
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.focus();
  mainWindow.flashFrame(true);
}

function clearAlert() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.flashFrame(false);
  mainWindow.setAlwaysOnTop(false);
}

// ---- IPC (renderer <-> main) --------------------------------------------
ipcMain.handle('get-state', () => ({
  name: config.name || null,
  roster: rosterList(),
  dndUntil,
}));

// Enable Do-Not-Disturb for `minutes` (0 turns it off). Safety cap keeps a
// station from silently missing pages all day.
ipcMain.handle('set-dnd', (_e, minutes) => {
  const m = Math.max(0, Math.min(Number(minutes) || 0, 240));
  dndUntil = m > 0 ? Date.now() + m * 60000 : 0;
  sendHeartbeat(); // let everyone else's roster update immediately
  return dndUntil;
});

ipcMain.handle('set-name', (_e, name) => {
  config.name = String(name || '').trim().slice(0, 40);
  saveConfig();
  sendHeartbeat();
  return config.name;
});

ipcMain.handle('send-page', (_e, { to, text }) => {
  const id = crypto.randomUUID();
  const packet = { type: 'page', id, from: config.name, to, text, ts: Date.now() };
  seenPages.add(id); // never show our own page to ourselves
  sendPacket(packet);
  return id;
});

ipcMain.handle('acknowledge', (_e, page) => {
  sendPacket({ type: 'ack', id: page.id, from: config.name, to: page.from });
  clearAlert();
});

ipcMain.handle('dismiss', () => clearAlert());

// ---- Window + tray -------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 540,
    height: 600,
    useContentSize: true, // height counts the page, not the title bar — less dead space
    minWidth: 420,
    minHeight: 520,
    icon: ICON_PATH,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  if (PROFILE) {
    // Test/profile mode: show the profile in the title bar so multiple copies
    // are easy to tell apart, and let each one close normally (no tray).
    mainWindow.on('page-title-updated', (e) => {
      e.preventDefault();
      mainWindow.setTitle('Serene Pager — ' + PROFILE);
    });
  } else {
    // Normal install: closing the window hides it to the tray so the station
    // keeps receiving pages.
    mainWindow.on('close', (e) => {
      if (!app.isQuitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    });
  }

  mainWindow.webContents.on('did-finish-load', () => {
    pushRoster();
    // Size the window to its actual content so there's no dead space at the
    // bottom, and it grows a little once the roster of stations fills in.
    const fit = async () => {
      try {
        const h = await mainWindow.webContents.executeJavaScript('document.body.scrollHeight');
        const [w] = mainWindow.getContentSize();
        mainWindow.setContentSize(w, Math.min(Math.max(Math.ceil(h), 460), 900));
      } catch { /* window gone */ }
    };
    setTimeout(fit, 400);
    setTimeout(fit, 1800); // re-fit after the first heartbeats populate the roster
  });
}

function createTray() {
  let img = nativeImage.createFromPath(ICON_PATH);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Serene Pager');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Serene Pager', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

// ---- App lifecycle -------------------------------------------------------
// Single-instance lock applies only to normal installs. Test/profile mode is
// meant to run many copies at once, so it skips the lock entirely.
if (!PROFILE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (!PROFILE) {
    app.on('second-instance', () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    });
  }

  app.whenReady().then(() => {
    if (PROFILE) {
      // Give each profile its own settings folder so their names don't collide
      // and Chromium's own per-profile lock doesn't block a second copy.
      const dir = path.join(app.getPath('userData'), 'profiles', PROFILE.replace(/[^\w .-]/g, '_'));
      fs.mkdirSync(dir, { recursive: true });
      app.setPath('userData', dir);
    }

    config = loadConfig();

    if (PROFILE && !config.name) {
      // Pre-name the test station so it skips the setup screen.
      config.name = PROFILE;
      saveConfig();
    }

    // Enable auto-start on the first run (normal installs only).
    if (!PROFILE && config.autoLaunchInitialized !== true) {
      app.setLoginItemSettings({ openAtLogin: true });
      config.autoLaunchInitialized = true;
      saveConfig();
    }

    createWindow();
    if (!PROFILE) createTray();
    startNetwork();
  });

  // Normal install stays alive in the tray; test copies quit when closed.
  app.on('window-all-closed', () => { if (PROFILE) app.quit(); });
}
