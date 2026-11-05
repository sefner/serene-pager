// Android only: gives ui/renderer.js the same `window.pager` that Electron's preload.js gives it on Windows, backed by
// the app's PagerService (window.PagerNative). Loaded before voice-clips.js and renderer.js by MainActivity, so the
// shared ui/ files stay exactly as they are on Windows.
(function () {
  'use strict';
  var N = window.PagerNative;
  var L = { roster: [], incoming: [], ack: [], cancelled: [] };
  window.__pagerEmit = function (type, data) {
    (L[type] || []).forEach(function (cb) { try { cb(data); } catch (e) { console.error(e); } });
  };
  function done(v) { return Promise.resolve(v); }
  window.pager = {
    getState: function () { return done(JSON.parse(N.getState())); },
    setName: function (name) { return done(N.setName(String(name || ''))); },
    sendPage: function (p) { return done(N.sendPage(JSON.stringify(p))); },
    setDnd: function (m) { return done(Number(N.setDnd(Number(m) || 0))); },
    acknowledge: function (page) { N.acknowledge(JSON.stringify(page)); return done(); },
    cancelPage: function (p) { N.cancelPage(JSON.stringify(p)); return done(); },
    dismiss: function () { N.dismiss(); return done(); },
    refit: function () { return done(); },          // a tablet window doesn't resize to its content
    raise: function () { N.raise(); return done(); },
    onRoster: function (cb) { L.roster.push(cb); },
    onIncoming: function (cb) { L.incoming.push(cb); },
    onAck: function (cb) { L.ack.push(cb); },
    onCancelled: function (cb) { L.cancelled.push(cb); },
  };

  // Android's WebView has no working speech synthesis, so a custom station name ("From Hygiene 2") would be silent.
  // Route renderer.js's speechSynthesis calls to Android's own text-to-speech.
  var pending = {}, n = 0;
  window.SpeechSynthesisUtterance = function (text) { this.text = text; this.rate = 1; this.volume = 1; };
  var synth = {
    speak: function (u) { var id = 'u' + (++n); pending[id] = u; N.speak(String(u.text || ''), id); },
    cancel: function () { N.stopSpeaking(); var p = pending; pending = {}; Object.keys(p).forEach(function (k) { if (p[k].onend) p[k].onend(); }); },
  };
  try { Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true }); } catch (e) { window.speechSynthesis = synth; }
  window.__pagerSpeechDone = function (id) { var u = pending[id]; delete pending[id]; if (u && u.onend) u.onend(); };
})();
