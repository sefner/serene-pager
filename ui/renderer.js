'use strict';

// Canned messages. `urgent: true` just tints the button red.
const MESSAGES = [
  { text: 'Doctor needed', urgent: true },
  { text: 'Assistance needed', urgent: true },
  { text: 'Room ready' },
  { text: 'Hygiene check' },
  { text: 'Ready for exam' },
  { text: 'Phone – Line 1' },
  { text: 'Phone – Line 2' },
  { text: 'Come when free' },
];

// Suggested station names on first run.
const PRESETS = ['Op 1', 'Op 2', 'Op 3', 'Op 4', 'Op 5', 'Op 6', 'Front Desk', 'Doctor'];

const DND_MINUTES = 30; // how long a snooze lasts when toggled on
const CHIME_COUNT = 3;  // chime this many times per page, then go silent (no endless noise)

const $ = (id) => document.getElementById(id);

let currentRoster = [];        // [{ name, dnd }]
let allMode = false;           // true = send to Everyone (nothing selected by default)
let selectedTargets = new Set();
let dndUntil = 0;
let dndTimer = null;
const quietLog = [];           // pages received while snoozed

// ---- Screens -------------------------------------------------------------
function show(screen) {
  $('setup').classList.toggle('hidden', screen !== 'setup');
  $('main').classList.toggle('hidden', screen !== 'main');
}

async function init() {
  const state = await window.pager.getState();
  currentRoster = state.roster || [];
  dndUntil = state.dndUntil || 0;
  if (!state.name) {
    renderSetup();
    show('setup');
  } else {
    $('me').textContent = state.name;
    renderMessages();
    renderTargets();
    reflectDnd();
    show('main');
  }
}

// ---- Setup screen --------------------------------------------------------
function renderSetup() {
  const grid = $('setup-presets');
  grid.innerHTML = '';
  for (const name of PRESETS) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => saveName(name);
    grid.appendChild(b);
  }
  $('setup-save').onclick = () => {
    const v = $('setup-input').value.trim();
    if (v) saveName(v);
  };
}

async function saveName(name) {
  await window.pager.setName(name);
  $('me').textContent = name;
  renderMessages();
  renderTargets();
  reflectDnd();
  show('main');
}

// ---- Targets (multi-select) ---------------------------------------------
function renderTargets() {
  const grid = $('targets');
  grid.innerHTML = '';

  const all = document.createElement('button');
  all.textContent = 'Everyone';
  all.dataset.target = 'ALL';
  all.onclick = () => { allMode = true; selectedTargets.clear(); paintSelection(); };
  grid.appendChild(all);

  for (const st of currentRoster) {
    const b = document.createElement('button');
    b.innerHTML = '<span class="dot"></span>';
    b.appendChild(document.createTextNode(st.name));
    if (st.dnd) {
      b.classList.add('snoozing');
      const tag = document.createElement('span');
      tag.className = 'snoozed-tag';
      tag.textContent = '🔕 snoozed';
      b.appendChild(tag);
    }
    b.dataset.target = st.name;
    b.onclick = () => toggleTarget(st.name);
    grid.appendChild(b);
  }

  // Drop any selected station that has gone offline.
  const online = new Set(currentRoster.map((s) => s.name));
  for (const n of [...selectedTargets]) if (!online.has(n)) selectedTargets.delete(n);

  paintSelection();
  $('empty').classList.toggle('hidden', currentRoster.length > 0);
}

function toggleTarget(name) {
  allMode = false;
  if (selectedTargets.has(name)) selectedTargets.delete(name);
  else selectedTargets.add(name);
  paintSelection();
}

function hasTarget() {
  return allMode || selectedTargets.size > 0;
}

function paintSelection() {
  for (const b of $('targets').querySelectorAll('button')) {
    const t = b.dataset.target;
    const on = t === 'ALL' ? allMode : selectedTargets.has(t);
    b.classList.toggle('selected', on);
  }
  // Message buttons are only tappable once a target is chosen — prevents an
  // accidental tap from paging the whole office.
  const ready = hasTarget();
  for (const b of $('messages').querySelectorAll('button')) b.disabled = !ready;
  $('msg-hint').classList.toggle('hidden', ready);
}

// ---- Messages ------------------------------------------------------------
function renderMessages() {
  const grid = $('messages');
  grid.innerHTML = '';
  for (const m of MESSAGES) {
    const b = document.createElement('button');
    b.textContent = m.text;
    if (m.urgent) b.classList.add('urgent');
    b.onclick = () => sendPage(m.text);
    grid.appendChild(b);
  }
}

async function sendPage(text) {
  if (!hasTarget()) return; // shouldn't happen (buttons disabled), but be safe
  const to = allMode ? 'ALL' : [...selectedTargets];
  await window.pager.sendPage({ to, text });
  const who = allMode ? 'everyone' : [...selectedTargets].join(', ');
  toast(`Sent to ${who}: ${text}`);
}

// ---- Do Not Disturb ------------------------------------------------------
$('dnd').onclick = () => setDnd(dndUntil > Date.now() ? 0 : DND_MINUTES);
$('dnd-off').onclick = () => setDnd(0);

async function setDnd(minutes) {
  dndUntil = await window.pager.setDnd(minutes);
  reflectDnd();
}

function reflectDnd() {
  const on = dndUntil > Date.now();
  $('dnd').classList.toggle('on', on);
  $('dnd').textContent = on ? 'Snoozing…' : 'Do Not Disturb';
  $('dnd-banner').classList.toggle('hidden', !on);
  if (dndTimer) { clearTimeout(dndTimer); dndTimer = null; }
  if (on) dndTimer = setTimeout(reflectDnd, Math.max(500, dndUntil - Date.now()));
}

// ---- Incoming alert ------------------------------------------------------
let pendingPage = null;

function showAlert(page) {
  pendingPage = page;
  $('alert-from').textContent = page.from || 'Unknown';
  $('alert-text').textContent = page.text || 'Page';
  $('alert').classList.remove('hidden');
  beep();
  speak(`${page.text}. From ${page.from}`);
}

$('alert-ack').onclick = async () => {
  if (pendingPage) await window.pager.acknowledge(pendingPage);
  pendingPage = null;
  $('alert').classList.add('hidden');
  stopBeep();
};

function logQuiet(page) {
  quietLog.unshift(page);
  if (quietLog.length > 10) quietLog.pop();
  const list = $('quiet-list');
  list.innerHTML = '';
  for (const p of quietLog) {
    const div = document.createElement('div');
    div.className = 'quiet-item';
    const time = new Date(p.ts || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    div.innerHTML = `<b></b><span></span><span class="t"></span>`;
    div.querySelector('b').textContent = p.from + ': ';
    div.querySelectorAll('span')[0].textContent = p.text;
    div.querySelector('.t').textContent = time;
    list.appendChild(div);
  }
  $('quiet').classList.remove('hidden');
}

// ---- Spoken page (Web Speech API — no library, no asset) ------------------
function speak(phrase) {
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(phrase);
    u.rate = 1.0;
    u.volume = 1.0;
    window.speechSynthesis.speak(u);
  } catch (e) { /* speech unavailable; chime + visual still fire */ }
}

// ---- Alert tone (Web Audio, no asset needed) -----------------------------
let audioCtx = null;
let beepTimer = null;

function beep() {
  stopBeep();
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    let count = 0;
    const ping = () => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = count % 2 === 0 ? 880 : 660;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.4, audioCtx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.36);
      count++;
      if (count >= CHIME_COUNT) stopBeep(); // short burst, then silence — never endless noise
    };
    ping();
    beepTimer = setInterval(ping, 500);
  } catch (e) { /* audio unavailable; visual alert still shows */ }
}

function stopBeep() {
  if (beepTimer) { clearInterval(beepTimer); beepTimer = null; }
}

// ---- Toast ---------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.classList.add('hidden'), 200);
  }, 2600);
}

// ---- Wire up main-process events -----------------------------------------
window.pager.onRoster((list) => {
  currentRoster = list || [];
  if (!$('main').classList.contains('hidden')) renderTargets();
});
window.pager.onIncoming((page) => {
  if (page.silent) { logQuiet(page); toast(`🔕 ${page.from}: ${page.text}`); }
  else showAlert(page);
});
window.pager.onAck((ack) => toast(`✓ ${ack.from} acknowledged`));

$('rename').onclick = () => { renderSetup(); show('setup'); };

init();
