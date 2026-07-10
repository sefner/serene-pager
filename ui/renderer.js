'use strict';

// Canned messages. `urgent: true` just tints the button red.
const MESSAGES = [
  { text: 'Doctor needed', urgent: true },
  { text: 'Assistance needed', urgent: true },
  { text: 'Room ready' },
  { text: 'Patient Ready' },
  { text: 'Perio Chart' },
  { text: 'Ready for exam' },
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

const REPEAT_SUPPRESS_MS = 10000; // identical repeat-taps within this window don't resend

function sameTargets(a, b) {
  if (a === 'ALL' || b === 'ALL') return a === b;
  return a.length === b.length && a.every((t) => b.includes(t));
}

async function sendPage(text) {
  if (!hasTarget()) return; // shouldn't happen (buttons disabled), but be safe
  const to = allMode ? 'ALL' : [...selectedTargets];
  const dup = sentLog.find((s) => !s.cancelled && s.text === text
    && sameTargets(s.to, to) && Date.now() - s.ts < REPEAT_SUPPRESS_MS);
  if (dup) {
    toast(isFullyAcked(dup) ? `Already sent & acknowledged: ${text}` : `Already sent — awaiting ✓: ${text}`);
    return;
  }
  const id = await window.pager.sendPage({ to, text });
  // Who has to acknowledge before this page counts as done: for "Everyone",
  // snapshot the stations online right now (late joiners never receive it).
  const expected = allMode ? currentRoster.map((s) => s.name) : [...selectedTargets];
  sentLog.unshift({ id, text, to, expected, ts: Date.now(), acks: [], cancelled: false, doneAt: 0 });
  if (sentLog.length > SENT_KEEP) sentLog.pop();
  renderSent();
  const who = allMode ? 'everyone' : [...selectedTargets].join(', ');
  toast(`Sent to ${who}: ${text}`);
}

// ---- Sent status (so the sender knows a page was seen — or can cancel it) --
const sentLog = [];                    // { id, text, to, ts, acks, cancelled, doneAt }
const SENT_KEEP = 5;                   // show at most this many recent pages
const SENT_DONE_LINGER_MS = 60000;     // acked/cancelled rows fade out after a minute

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} hr ${mins % 60} min ago`;
}

function isFullyAcked(s) {
  return s.expected.length > 0 && s.expected.every((t) => s.acks.includes(t));
}

function sentStatus(s) {
  if (s.cancelled) return { text: 'cancelled', ok: false };
  if (isFullyAcked(s)) return { text: '✓ acknowledged', ok: true };
  const acked = s.acks.join(', ');
  const waiting = s.expected.filter((t) => !s.acks.includes(t)).join(', ');
  return {
    text: (acked ? `✓ ${acked} · ` : '') + `awaiting ${waiting || '✓'} · sent ${timeAgo(s.ts)}`,
    ok: false,
  };
}

async function cancelSent(s) {
  await window.pager.cancelPage({ id: s.id, to: s.to });
  s.cancelled = true;
  s.doneAt = Date.now();
  renderSent();
}

function renderSent() {
  // Finished rows (acked or cancelled) drop off after lingering briefly.
  const now = Date.now();
  for (let i = sentLog.length - 1; i >= 0; i--) {
    if (sentLog[i].doneAt && now - sentLog[i].doneAt > SENT_DONE_LINGER_MS) sentLog.splice(i, 1);
  }
  const list = $('sent-list');
  list.innerHTML = '';
  for (const s of sentLog) {
    const row = document.createElement('div');
    row.className = 'sent-item';
    const info = document.createElement('div');
    const line = document.createElement('div');
    line.innerHTML = '<b></b><span class="to"></span>';
    line.querySelector('b').textContent = s.text;
    line.querySelector('.to').textContent = ' → ' + (s.to === 'ALL' ? 'everyone' : s.to.join(', '));
    const status = document.createElement('div');
    const st = sentStatus(s);
    status.className = 'status' + (st.ok ? ' ok' : '');
    status.textContent = st.text;
    info.append(line, status);
    row.appendChild(info);
    if (!s.cancelled && !isFullyAcked(s)) {
      const cancel = document.createElement('button');
      cancel.className = 'link';
      cancel.textContent = 'Cancel';
      cancel.onclick = () => cancelSent(s);
      row.appendChild(cancel);
    }
    list.appendChild(row);
  }
  $('sent').classList.toggle('hidden', sentLog.length === 0);
}

// ---- Do Not Disturb ------------------------------------------------------
$('dnd').onclick = () => setDnd(dndUntil > Date.now() ? 0 : DND_MINUTES);
$('dnd-off').onclick = () => setDnd(0);

async function setDnd(minutes) {
  dndUntil = await window.pager.setDnd(minutes);
  reflectDnd();
}

let wasDnd = false;
function reflectDnd() {
  const on = dndUntil > Date.now();
  if (wasDnd && !on) promoteQuiet(); // snooze just ended (manually or auto)
  wasDnd = on;
  $('dnd').classList.toggle('on', on);
  $('dnd').textContent = on ? 'Snoozing…' : 'Do Not Disturb';
  $('dnd-banner').classList.toggle('hidden', !on);
  if (dndTimer) { clearTimeout(dndTimer); dndTimer = null; }
  if (on) dndTimer = setTimeout(reflectDnd, Math.max(500, dndUntil - Date.now()));
}

// ---- Incoming alert (queue — pages stack until each is acknowledged) ------
let pendingPages = [];

// The same message from the same station coalesces into one card (marked
// ×N) instead of stacking duplicates that each demand an acknowledge.
function queuePage(page) {
  const dup = pendingPages.find((p) => p.from === page.from && p.text === page.text);
  if (dup) dup.repeats = (dup.repeats || []).concat(page); // acked together later
  else pendingPages.push(page);
}

function showAlert(page) {
  queuePage(page);
  renderAlerts();
  beep();
  speakPage(page);
}

// Snooze defers pages, it doesn't discard them: when DND ends, everything
// that arrived quietly (and wasn't cancelled) becomes a live alert to
// acknowledge — original timestamps intact, so ages read true.
function promoteQuiet() {
  const due = quietLog.filter((p) => !p.cancelled);
  quietLog.length = 0;
  renderQuiet();
  if (!due.length) return;
  for (const p of due) queuePage(p);
  renderAlerts();
  window.pager.raise(); // window may be hidden in the tray on auto-resume
  beep();
  speak(due.length === 1 ? 'One page arrived while snoozed' : `${due.length} pages arrived while snoozed`);
}

function renderAlerts() {
  const list = $('alert-list');
  list.innerHTML = '';
  for (const p of pendingPages) {
    const item = document.createElement('div');
    item.className = 'alert-item';
    const from = document.createElement('div');
    from.className = 'alert-from';
    from.innerHTML = '<span></span><span class="alert-when"></span>';
    from.querySelector('span').textContent = p.from || 'Unknown';
    from.querySelector('.alert-when').textContent = ` · ${timeOf(p.ts)} (${timeAgo(p.ts)})`;
    const text = document.createElement('div');
    text.className = 'alert-text';
    text.textContent = (p.text || 'Page') + (p.repeats ? ` ×${p.repeats.length + 1}` : '');
    const btn = document.createElement('button');
    btn.className = 'primary big';
    btn.textContent = 'Acknowledge';
    btn.onclick = async () => {
      // Ack every coalesced copy so each shows ✓ in the sender's Sent list.
      for (const pg of [p, ...(p.repeats || [])]) await window.pager.acknowledge(pg);
      removePending(p.id);
    };
    item.append(from, text, btn);
    list.appendChild(item);
  }
  $('alert').classList.toggle('hidden', pendingPages.length === 0);
}

function removePending(id) {
  pendingPages = pendingPages.filter((p) => p.id !== id);
  renderAlerts();
  if (pendingPages.length === 0) {
    stopBeep();
    window.pager.dismiss(); // stop flashing / drop always-on-top
  }
}

function logQuiet(page) {
  quietLog.unshift(page);
  if (quietLog.length > 10) quietLog.pop();
  renderQuiet();
}

function renderQuiet() {
  const list = $('quiet-list');
  list.innerHTML = '';
  for (const p of quietLog) {
    const div = document.createElement('div');
    div.className = 'quiet-item' + (p.cancelled ? ' cancelled' : '');
    div.innerHTML = `<b></b><span></span><span class="t"></span>`;
    div.querySelector('b').textContent = p.from + ': ';
    div.querySelectorAll('span')[0].textContent = p.text + (p.cancelled ? ' (no longer needed)' : '');
    div.querySelector('.t').textContent = timeOf(p.ts || Date.now());
    list.appendChild(div);
  }
  $('quiet').classList.toggle('hidden', quietLog.length === 0);
}

// ---- Spoken page (pre-rendered premium clips, with system-voice fallback) --
// A calm, spa-quality voice is pre-rendered per canned message (and per preset
// station). The clips are embedded as base64 data URIs in voice-clips.js
// (window.VOICE_CLIPS) — NOT loaded as files — because HTML5 audio cannot
// stream from inside app.asar. We play the message clip, then the "From
// <station>" clip. Anything without a clip — e.g. a station renamed to a
// custom name — falls back to the Web Speech voice so it's never silent.

// Must match the slugs used when the clips were generated: lowercase, and every
// run of non-alphanumeric characters collapsed to a single dash.
function voiceSlug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Play one embedded clip by key (filename without extension). Resolves when it
// finishes; rejects if there's no clip for that key or playback fails, so the
// caller can fall back to spoken text.
function playClip(key) {
  return new Promise((resolve, reject) => {
    const src = window.VOICE_CLIPS && window.VOICE_CLIPS[key];
    if (!src) return reject(new Error('no clip: ' + key));
    const a = new Audio(src);
    a.onended = resolve;
    a.onerror = () => reject(new Error('clip failed: ' + key));
    a.play().catch(reject);
  });
}

// Speak an incoming page: message clip, then "From <station>" clip. Each half
// falls back to the system voice independently, so a custom station name still
// gets announced even though only the message half has a bundled clip.
async function speakPage(page) {
  try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) {}
  const text = page.text || 'Page';
  const from = page.from || 'Unknown';
  await playClip(voiceSlug(text)).catch(() => speakAndWait(text));
  await playClip('from-' + voiceSlug(from)).catch(() => speakAndWait('From ' + from));
}

// speechSynthesis wrapper that resolves when the utterance finishes (so the
// message and station halves don't talk over each other in the fallback path).
function speakAndWait(phrase) {
  return new Promise((resolve) => {
    try {
      if (!('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(phrase);
      u.rate = 1.0;
      u.volume = 1.0;
      u.onend = resolve;
      u.onerror = resolve;
      window.speechSynthesis.speak(u);
    } catch (e) { resolve(); }
  });
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
window.pager.onAck((ack) => {
  const s = sentLog.find((x) => x.id === ack.id);
  if (s && !s.acks.includes(ack.from)) {
    s.acks.push(ack.from);
    if (isFullyAcked(s)) s.doneAt = Date.now();
    renderSent();
  }
  toast(`✓ ${ack.from} acknowledged`);
});
window.pager.onCancelled((c) => {
  // Cancelling any copy of a coalesced page withdraws the whole card — the
  // sender no longer needs that message, however many times it was tapped.
  const hit = pendingPages.find((p) => p.id === c.id || (p.repeats || []).some((r) => r.id === c.id));
  if (hit) removePending(hit.id);
  const q = quietLog.find((p) => p.id === c.id);
  if (q && !q.cancelled) { q.cancelled = true; renderQuiet(); }
  if (hit || q) toast(`${c.from} cancelled the page — no longer needed`);
});

// Keep "N min ago" ages fresh, and let finished Sent rows fade out.
setInterval(() => {
  if (pendingPages.length) renderAlerts();
  renderSent();
}, 30000);

$('rename').onclick = () => { renderSetup(); show('setup'); };

// Ask the main process to re-fit the window height whenever content changes
// (sections toggling, lists growing) — debounced so bursts measure once.
let refitTimer = null;
new MutationObserver(() => {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => window.pager.refit(), 250);
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

init();
