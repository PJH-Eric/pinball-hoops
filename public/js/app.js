/* ===== app.js — 畫面、遊戲迴圈、設定視窗、線上房間與觀戰 ===== */
(function () {
  'use strict';

  var Rules = window.Rules, Store = window.Store, Audio = window.GameAudio;
  var Render = window.Render, Net = window.Net, Config = window.Config;

  /* ---------- 小工具 ---------- */
  function $(s, root) { return (root || document).querySelector(s); }
  function $$(s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); }

  /** 建立元素；文字一律用 textContent，暱稱之類的外來字串不會被當成 HTML */
  function h(tag, props) {
    var el = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  var app = $('#app');
  var toastEl = $('#toast'), toastTimer = null;
  function toast(text, ms) {
    toastEl.textContent = text;
    toastEl.className = 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ''; }, ms || 2600);
  }

  function vibrate(p) {
    if (Store.get('vibrate') && navigator.vibrate) { try { navigator.vibrate(p); } catch (e) { /* 忽略 */ } }
  }
  function sfx(n, p) { Audio.sfx(n, p); }

  /* ---------- 設定套用 ---------- */
  function applySettings() {
    var s = Store.all();
    var cl = document.body.classList;
    cl.toggle('reduce-motion', !!s.reduceMotion);
    cl.toggle('hints-on', !!s.showHints);
    Audio.configure(s);
    Audio.music(s.musicOn);
    if (rend) rend.bg = null;
  }

  var unlocked = false;
  function firstGesture() {
    if (unlocked) return;
    unlocked = true;
    Audio.unlock();
    Audio.music(Store.get('musicOn'));
  }
  window.addEventListener('pointerdown', firstGesture, { passive: true });
  window.addEventListener('keydown', firstGesture);

  /* ---------- 畫面切換 ---------- */
  var screen = 'home';
  var chatEl = $('#chat');

  function go(name) {
    screen = name;
    app.dataset.screen = name;
    if (name !== 'play') { stopLoop(); }
    placeChat();
    if (name === 'home') renderBest();
    if (name === 'lobby') enterLobby();
    if (name === 'solo') renderSoloDiffs();
    if (name === 'play') { startLoop(); requestAnimationFrame(layout); }
    sfx('ui');
  }

  $$('[data-go]').forEach(function (b) {
    b.addEventListener('click', function () {
      var to = b.getAttribute('data-go');
      if (screen === 'lobby' && to === 'home') { Net.disconnect(); }
      go(to);
    });
  });

  window.addEventListener('popstate', function () { /* 首頁按上一頁＝回遊戲大廳（瀏覽器預設行為） */ });

  function renderBest() {
    var b = Store.get('best') || {};
    var parts = Rules.DIFF_LIST.filter(function (d) { return b[d]; }).map(function (d) { return Rules.DIFFS[d].name + ' ' + b[d]; });
    $('#bestLine').textContent = parts.length ? '本機最高分：' + parts.join('　') : '還沒有紀錄，來挑戰看看！';
  }

  /* ---------- 單機：選難度 ---------- */
  var soloDiff = 'normal';
  function renderSoloDiffs() {
    var box = $('#diffGrid');
    box.textContent = '';
    var best = Store.get('best') || {};
    Rules.DIFF_LIST.forEach(function (id) {
      var d = Rules.DIFFS[id];
      var btn = h('button', { class: 'diff', type: 'button', role: 'radio', 'aria-checked': String(id === soloDiff), 'data-diff': id },
        h('b', { text: d.name }), h('span', { text: d.blurb }),
        h('em', { text: best[id] ? '最高分 ' + best[id] : '尚未挑戰' }));
      btn.addEventListener('click', function () { soloDiff = id; renderSoloDiffs(); sfx('ui'); });
      box.appendChild(btn);
    });
  }
  $('#btnSoloStart').addEventListener('click', function () {
    startPlay({ mode: 'solo', diff: soloDiff, seed: (Math.random() * 4294967296) >>> 0 });
  });

  /* ---------- 設定視窗（Modal） ---------- */
  var modalOpener = null;
  $('#btnSettings').addEventListener('click', function (e) { openSettings(e.currentTarget); });

  function sw(label, key, onChange) {
    var btn = h('button', { class: 'sw', type: 'button', role: 'switch', 'aria-checked': String(!!Store.get(key)), 'aria-label': label }, h('i'));
    btn.addEventListener('click', function () {
      var on = btn.getAttribute('aria-checked') !== 'true';
      btn.setAttribute('aria-checked', String(on));
      Store.set(key, on); applySettings(); sfx('ui');
      if (onChange) onChange(on);
    });
    return h('div', { class: 'row' }, h('span', { text: label }), btn);
  }

  function meter(label, key) {
    var box = h('div', { class: 'meter', role: 'group', 'aria-label': label + '音量' });
    function paint() {
      $$('button', box).forEach(function (b, i) { b.classList.toggle('on', i < Store.get(key)); });
    }
    for (var i = 1; i <= 5; i++) {
      (function (n) {
        var b = h('button', { type: 'button', 'aria-label': label + '音量 ' + n });
        b.addEventListener('click', function () {
          Store.set(key, Store.get(key) === n ? n - 1 : n);
          applySettings(); paint(); sfx('bump');
        });
        box.appendChild(b);
      })(i);
    }
    paint();
    return h('div', { class: 'row' }, h('span', { text: label + '音量' }), box);
  }

  function openSettings(opener) {
    if (document.getElementById('settingsModal')) return;
    modalOpener = opener || document.activeElement;
    var wasRunning = play && play.mode === 'solo' && play.running && !play.paused && !play.over;
    if (wasRunning) pauseSolo(true);

    var back = h('div', { class: 'modal-back', id: 'settingsModal' });
    var dlg = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'setTitle' });
    dlg.appendChild(h('h2', { id: 'setTitle', text: '設定' }));
    dlg.appendChild(sw('背景音樂', 'musicOn'));
    dlg.appendChild(meter('音樂', 'musicLevel'));
    dlg.appendChild(sw('音效', 'sfxOn', function (on) { if (on) sfx('bump'); }));
    dlg.appendChild(meter('音效', 'sfxLevel'));
    dlg.appendChild(sw('震動', 'vibrate', function (on) { if (on) vibrate(30); }));
    dlg.appendChild(sw('減少動態（關閉拖尾、粒子、震動）', 'reduceMotion'));
    dlg.appendChild(sw('高對比（加粗輪廓）', 'contrast'));
    dlg.appendChild(sw('顯示鍵盤提示', 'showHints'));

    var btns = h('div', { class: 'actions' });
    var reset = h('button', { class: 'btn small ghost', type: 'button', text: '恢復預設' });
    reset.addEventListener('click', function () { Store.reset(); applySettings(); closeSettings(); openSettings(modalOpener); toast('已恢復預設'); });
    var close = h('button', { class: 'btn small primary', type: 'button', text: '關閉' });
    close.addEventListener('click', closeSettings);
    btns.appendChild(reset); btns.appendChild(close);
    dlg.appendChild(btns);
    back.appendChild(dlg);
    back.addEventListener('pointerdown', function (e) { if (e.target === back) closeSettings(); });
    $('#modalRoot').appendChild(back);

    back.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeSettings(); return; }
      if (e.key !== 'Tab') return;
      var f = $$('button', dlg).filter(function (x) { return !x.disabled; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    $('#app').setAttribute('aria-hidden', 'false');
    setTimeout(function () { var f = $('button', dlg); if (f) f.focus(); }, 0);
  }

  function closeSettings() {
    var m = document.getElementById('settingsModal');
    if (!m) return;
    m.remove();
    if (modalOpener && modalOpener.focus) modalOpener.focus();
    modalOpener = null;
  }

  /* ---------- 輸入：只有一片彈板，點畫面任何地方（或按任意鍵）就揮板 ---------- */
  var keysDown = {}, pointers = {};
  var FLIP_KEYS = { Space: 1, ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, KeyZ: 1, KeyX: 1, KeyA: 1, KeyD: 1, KeyL: 1, Slash: 1, Enter: 1 };

  function typing() {
    var a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  }
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && screen === 'play' && !document.getElementById('settingsModal')) {
      if (play && play.mode === 'solo' && play.running && !play.over) { pauseSolo(!play.paused); e.preventDefault(); }
      return;
    }
    if (screen !== 'play' || typing() || document.getElementById('settingsModal')) return;
    if (FLIP_KEYS[e.code] && !(e.code === 'Enter' && document.activeElement && document.activeElement.tagName === 'BUTTON')) {
      if (e.code === 'Space' && document.activeElement && document.activeElement.tagName === 'BUTTON') return;
      keysDown[e.code] = true; e.preventDefault();
    }
  });
  window.addEventListener('keyup', function (e) { delete keysDown[e.code]; });
  window.addEventListener('blur', function () { keysDown = {}; pointers = {}; });

  /* 整個遊戲畫面都是「揮板鍵」：按鈕、面板、對話框、觀戰分頁除外 */
  var stageEl = $('#stage');
  function isUi(t) { return t.closest && t.closest('button, a, input, #overlay, #panel, .spec-tabs, #hud'); }
  stageEl.addEventListener('pointerdown', function (e) {
    if (isUi(e.target) || (play && play.mode === 'spec')) return;
    pointers[e.pointerId] = true;
    try { stageEl.setPointerCapture(e.pointerId); } catch (x) { /* 忽略 */ }
    e.preventDefault();
    stageEl.classList.add('is-down');
  });
  function release(e) {
    delete pointers[e.pointerId];
    if (!Object.keys(pointers).length) stageEl.classList.remove('is-down');
  }
  stageEl.addEventListener('pointerup', release);
  stageEl.addEventListener('pointercancel', release);
  stageEl.addEventListener('lostpointercapture', release);
  stageEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  function currentInput() {
    return { flip: Object.keys(keysDown).length > 0 || Object.keys(pointers).length > 0 };
  }

  /* ---------- 遊戲主控 ---------- */
  var cv = $('#cv');
  var rend = Render.create(cv);
  var play = null;            /* 目前這局的狀態 */
  var raf = 0, lastTs = 0;

  function layout() {
    var wrap = $('#cvWrap');
    if (!wrap) return;
    var w = wrap.clientWidth, hgt = wrap.clientHeight;
    if (w < 40 || hgt < 40) return;
    var cw = Math.floor(Math.min(w - 4, (hgt - 4) * 2 / 3));
    var ch = Math.floor(cw * 1.5);
    rend.resize(cw, ch, Math.min(window.devicePixelRatio || 1, 2.5));
  }
  window.addEventListener('resize', function () { layout(); applyPanelMode(); });
  window.addEventListener('orientationchange', function () { setTimeout(function () { layout(); applyPanelMode(); }, 200); });
  if (window.ResizeObserver) new ResizeObserver(layout).observe($('#cvWrap'));

  function startLoop() { if (!raf) { lastTs = 0; raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  function startPlay(o) {
    closeOverlay();
    rend.reset();
    var online = o.mode === 'online' || o.mode === 'spec';
    play = {
      mode: o.mode, diff: o.diff, seed: o.seed, roomId: o.roomId || null, round: o.round || 0,
      g: o.mode === 'spec' ? null : Rules.create(o.diff, o.seed, o.mode === 'online'),
      startAt: o.startAt || 0, cd: 3.2, cdShown: 0, running: false, paused: false, over: false,
      lastReport: 0, lastSnap: 0, lastScore: -1, resultShown: false, newBest: false,
      focus: null, disp: null, snaps: {}
    };
    app.dataset.online = online ? '1' : '0';
    app.dataset.solo = online ? '0' : '1';
    app.dataset.spectator = o.mode === 'spec' ? '1' : '0';
    $('#btnPause').textContent = o.mode === 'solo' ? '暫停' : '離開';
    if (o.mode === 'spec') { play.running = true; buildSpecTabs(); }
    go('play');
    applyPanelMode(true);
    updateHud(true);
    updateSummary();
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    var dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    if (screen !== 'play' || !play) return;
    var p = play, inp = currentInput(), view, opts;
    opts = { reduceMotion: !!Store.get('reduceMotion'), contrast: !!Store.get('contrast'), pressed: [inp.flip] };

    if (p.mode === 'spec') {
      view = specView(dt);
      if (view) { opts.pressed = [view.fl[0] < Rules.REST - 0.2]; rend.draw(view, opts); }
      else rend.draw(idleView(), opts);
      updateHud();
      return;
    }

    var g = p.g;
    if (!p.running) {
      if (p.mode === 'solo') {
        if (!p.paused) p.cd -= dt;
        var n = Math.ceil(p.cd);
        if (p.cd > 0) showCount(n); else startRunning();
      } else {
        var rem = (p.startAt - Net.serverNow()) / 1000;
        if (rem > 0) showCount(Math.ceil(rem)); else startRunning();
      }
    } else if (!p.paused && !p.over) {
      var input = inp;
      if (p.mode === 'online') {
        var target = (Net.serverNow() - p.startAt) / 1000;
        var lag = Math.min(target - g.t, 30), loops = 0;
        while (lag > 0.0001 && loops < 40 && g.status === 'playing') {
          var step = Math.min(0.1, lag);
          Rules.update(g, step, input);
          lag -= step; loops++;
        }
      } else {
        Rules.update(g, dt, input);
      }
      handleEvents(g);
      if (g.status === 'over' && !p.over) onLocalOver();
      onlineReport();
    }

    opts.bumperFlash = g.bumperFlash;
    rend.draw(Rules.view(g), opts);
    updateHud();
  }

  function idleView() {
    var geo = Rules.geometry(play.diff);
    return { diff: play.diff, ball: null, fl: [Rules.REST], hx: geo.hoop.x, hy: geo.hoop.cy, score: 0, combo: 0, ballNo: 0, t: 0 };
  }

  var lastCount = 0;
  function showCount(n) {
    if (play.mode === 'solo' && play.paused) return;
    if (n === lastCount && $('#overlay .count')) return;
    lastCount = n;
    var ov = $('#overlay');
    ov.hidden = false; ov.textContent = '';
    ov.style.background = 'rgba(5,7,15,.35)';
    ov.appendChild(h('div', { class: 'count', text: String(Math.max(1, n)) }));
    sfx('count');
  }

  function startRunning() {
    play.running = true;
    lastCount = 0;
    closeOverlay();
    sfx('go');
    if (!play.mode || play.mode !== 'spec') { rend.pop(300, 420, '開球！', '#ffe14d'); }
  }

  function handleEvents(g) {
    var geo = g.geo;
    for (var i = 0; i < g.events.length; i++) {
      var e = g.events[i];
      switch (e.type) {
        case 'flip': sfx('flip'); break;
        case 'flipHit': sfx('flipHit', e.power); break;
        case 'wall': sfx('wall', e.power); break;
        case 'pad': sfx('pad'); break;
        case 'serve': sfx('serve'); break;
        case 'rim': sfx('rim', e.power); break;
        case 'bump':
          sfx('bump');
          rend.spark(geo.bumpers[e.index].x, geo.bumpers[e.index].y, '#22e4ff', 6);
          onlineReportSoon();
          break;
        case 'score':
          sfx(e.swish ? 'swish' : 'score');
          if (e.combo > 1) sfx('combo');
          rend.flash(); rend.shake(8);
          rend.spark(g.hoopX, g.hoopY + 10, '#ffe14d', 22);
          rend.pop(Math.min(g.hoopX, 470), g.hoopY + 56, '+' + e.points + (e.swish ? ' 空心' : ''), e.swish ? '#22e4ff' : '#ffe14d');
          vibrate(e.swish ? [30, 40, 30] : 30);
          onlineReportSoon();
          break;
        case 'drain':
          sfx('drain'); vibrate(80);
          rend.pop(300, 800, !g.unlimited && g.diff.balls > 0 && g.ballNo >= g.diff.balls ? '球用完了' : '漏球！', '#ff3d9a');
          onlineReportSoon();
          break;
      }
    }
    g.events.length = 0;
  }

  function onLocalOver() {
    var p = play, g = p.g;
    p.over = true;
    sfx('buzzer');
    vibrate([100, 60, 100]);
    if (p.mode === 'solo') {
      p.newBest = Store.recordBest(g.diff.id, g.score);
      setTimeout(function () { if (play === p) { sfx(p.newBest ? 'win' : 'ui'); } }, 600);
      setTimeout(function () { if (play === p) showResult(); }, 900);
    } else {
      onlineReport(true);
      setTimeout(function () { if (play === p) showResult(); }, 900);
    }
  }

  /* ---------- 線上：回報分數、觀戰畫面 ---------- */
  var reportSoon = false;
  function onlineReportSoon() { reportSoon = true; }
  function onlineReport(done) {
    var p = play;
    if (!p || p.mode !== 'online') return;
    var now = performance.now(), g = p.g;
    if (done || (reportSoon && now - p.lastReport > 150) || now - p.lastReport > 800) {
      reportSoon = false;
      p.lastReport = now;
      Net.send({ type: 'score', score: g.score, hoops: g.hoops, combo: g.combo, ballNo: g.ballNo, done: !!done });
    }
    if (online.room && online.room.specs.length && now - p.lastSnap > 100) {
      p.lastSnap = now;
      var b = g.ball;
      Net.send({ type: 'snap', b: b ? [b.x, b.y, b.spin] : null, f: [g.fl[0].a], h: g.hoopY });
    }
  }

  function specView(dt) {
    var p = play, room = online.room;
    if (!room) return null;
    var ids = room.players.map(function (x) { return x.id; });
    if (!p.focus || ids.indexOf(p.focus) < 0) { p.focus = ids[0] || null; buildSpecTabs(); }
    var s = p.snaps[p.focus];
    if (!s) return null;
    var d = p.disp;
    if (!d || d.id !== p.focus) d = p.disp = { id: p.focus, x: 0, y: 0, hy: 260, f0: Rules.REST, init: false, ball: null, spin: 0 };
    var k = Math.min(1, dt * 18);
    if (s.b) {
      if (!d.ball || !d.init) { d.x = s.b[0]; d.y = s.b[1]; d.init = true; }
      d.x += (s.b[0] - d.x) * k; d.y += (s.b[1] - d.y) * k; d.spin = s.b[2];
      d.ball = true;
    } else d.ball = false;
    d.hy += (s.h - d.hy) * k; d.f0 += (s.f[0] - d.f0) * k;
    return { diff: room.difficulty, ball: d.ball ? { x: d.x, y: d.y, spin: d.spin } : null, fl: [d.f0], hx: Rules.geometry(room.difficulty).hoop.x, hy: d.hy, score: s.s, combo: s.c, ballNo: 0, t: 0 };
  }

  function buildSpecTabs() {
    var box = $('#specTabs');
    box.textContent = '';
    if (!play || play.mode !== 'spec' || !online.room) return;
    online.room.players.forEach(function (pl) {
      var b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(play.focus === pl.id), text: pl.name });
      b.addEventListener('click', function () { play.focus = pl.id; play.disp = null; buildSpecTabs(); sfx('ui'); });
      box.appendChild(b);
    });
  }

  Net.on('snaps', function (m) {
    if (!play || play.mode !== 'spec') return;
    play.snaps = m.s || {};
  });

  /* ---------- HUD 與資訊欄 ---------- */
  var hudCache = {};
  function setText(id, v) {
    if (hudCache[id] === v) return;
    hudCache[id] = v;
    $('#' + id).textContent = v;
  }

  function updateHud(force) {
    var p = play;
    if (!p) return;
    if (force) hudCache = {};
    var g = p.g, score, left, total, balls = null, combo = 0;
    if (p.mode === 'spec') {
      var room = online.room;
      var pl = room && room.players.filter(function (x) { return x.id === p.focus; })[0];
      score = pl ? pl.score : 0;
      var dur = room ? Rules.DIFFS[room.difficulty].duration : 90;
      left = room && room.startAt ? Math.max(0, Math.min(dur, (room.endsAt - Net.serverNow()) / 1000)) : dur;
      total = dur;
      combo = pl ? pl.combo : 0;
    } else {
      score = g.score; left = Rules.timeLeft(g); total = g.diff.duration; combo = g.combo;
      if (g.t - g.lastScoreT > Rules.COMBO_WINDOW) combo = 0;
      balls = g.unlimited ? 0 : g.diff.balls;
    }
    setText('hScore', String(score));
    setText('hTime', String(Math.ceil(left)));
    $('#hBar').style.transform = 'scaleX(' + (Math.max(0, left) / total).toFixed(3) + ')';
    var ballsEl = $('#hBalls');
    var key = p.mode === 'spec' ? 'spec' : (balls === 0 ? 'inf' : balls + ':' + g.ballNo);
    if (hudCache.balls !== key) {
      hudCache.balls = key;
      ballsEl.textContent = '';
      if (p.mode === 'spec') ballsEl.appendChild(h('b', { text: '—' }));
      else if (balls === 0) ballsEl.appendChild(h('b', { text: '∞' }));
      else for (var i = 0; i < balls; i++) ballsEl.appendChild(h('i', { class: 'ball-ico' + (i < g.ballNo - 1 || (!g.ball && i < g.ballNo) ? ' used' : '') }));
    }
    var ce = $('#hCombo');
    ce.hidden = combo < 2;
    if (combo >= 2) setText('hComboN', String(combo));
    if (p.mode === 'solo' || p.mode === 'online') {
      var s = p.mode === 'solo' ? ('s' + g.hoops + ':' + g.swishes + ':' + g.bumps + ':' + g.bestCombo) : 'o';
      if (hudCache.sum !== s) { hudCache.sum = s; updateSummary(); }
    }
  }

  function updateSummary() {
    var box = $('#sumBox');
    if (!play) return;
    box.textContent = '';
    box.className = 'sum';
    if (play.mode === 'solo') {
      var g = play.g, best = (Store.get('best') || {})[g.diff.id] || 0;
      box.appendChild(h('h4', { text: '單機 · ' + g.diff.name }));
      [['本機最高', best], ['進球', g.hoops], ['空心球', g.swishes], ['最高連擊', '×' + g.bestCombo], ['彈跳墊', g.bumps]].forEach(function (r) {
        box.appendChild(h('div', { class: 'kv' }, h('span', { text: r[0] }), h('b', { text: String(r[1]) })));
      });
      box.appendChild(h('p', { class: 'muted', text: '點畫面任何地方揮板　Esc 暫停' }));
      return;
    }
    var room = online.room;
    if (!room) return;
    box.appendChild(h('h4', { text: '房間 ' + room.id + ' · ' + Rules.DIFFS[room.difficulty].name }));
    var ol = h('ol', { class: 'rank' });
    room.players.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (pl, i) {
      ol.appendChild(h('li', { class: pl.id === room.you.id ? 'me' : '' },
        h('span', { class: 'no', text: String(i + 1) }), h('span', { text: pl.name + (pl.connected ? '' : '（離線）') }), h('span', { class: 'sc', text: String(pl.score) })));
    });
    box.appendChild(ol);
    if (room.specs.length) box.appendChild(h('p', { class: 'muted', text: '觀戰 ' + room.specs.length + ' 人' }));
    if (room.you.role === 'spec') box.appendChild(h('p', { class: 'muted', text: '你是觀戰者' }));
  }

  /* 資訊欄：寬版固定在左、窄版從左側滑出 */
  var wideMq = window.matchMedia('(min-width: 900px) and (min-height: 600px)');
  var panelOpen = wideMq.matches;
  function applyPanelMode(reset) {
    if (reset) panelOpen = wideMq.matches;
    var sp = $('#s-play');
    sp.classList.toggle('panel-closed', wideMq.matches && !panelOpen);
    sp.classList.toggle('panel-open', !wideMq.matches && panelOpen);
    $('#panelToggle').setAttribute('aria-expanded', String(panelOpen));
    placeChat();
    if (panelOpen) clearUnread();
    setTimeout(layout, 30);
  }
  if (wideMq.addEventListener) wideMq.addEventListener('change', function () { applyPanelMode(true); });
  $('#panelToggle').addEventListener('click', function () { panelOpen = !panelOpen; applyPanelMode(); sfx('ui'); });
  $('#panelClose').addEventListener('click', function () { panelOpen = false; applyPanelMode(); sfx('ui'); });
  $('#btnPause').addEventListener('click', function () {
    if (!play) return;
    if (play.mode === 'solo') { if (play.running && !play.over) pauseSolo(!play.paused); }
    else confirmLeaveOnline();
  });

  /* 線上不能暫停（其他人還在打），但可以隨時離開：先確認，比賽不會因此中斷 */
  function closeLeaveConfirm() { var m = document.getElementById('leaveModal'); if (m) m.remove(); }

  function confirmLeaveOnline() {
    if (document.getElementById('leaveModal')) return;
    var isSpec = play.mode === 'spec';
    var back = h('div', { class: 'modal-back', id: 'leaveModal' });
    function close() { back.remove(); }
    var stay = h('button', { class: 'btn primary', type: 'button', text: '繼續比賽' });
    var quit = h('button', { class: 'btn ghost', type: 'button', text: '離開' });
    stay.addEventListener('click', close);
    quit.addEventListener('click', function () { close(); leavePlay('home'); });
    back.appendChild(h('div', { class: 'modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': '離開比賽' },
      h('h2', { text: '離開比賽？' }),
      h('p', { class: 'muted', text: isSpec ? '離開後會回到首頁，比賽仍會繼續。' : '離開後會回到首頁，目前的分數會保留在排名中，比賽仍會繼續。' }),
      h('div', { class: 'actions' }, stay, quit)));
    back.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); close(); } });
    back.addEventListener('pointerdown', function (ev) { if (ev.target === back) close(); });
    $('#modalRoot').appendChild(back);
    stay.focus();
  }

  /* ---------- 暫停、結算 ---------- */
  function closeOverlay() { var ov = $('#overlay'); ov.hidden = true; ov.textContent = ''; ov.style.background = ''; lastCount = 0; }

  function pauseSolo(on) {
    if (!play || play.mode !== 'solo') return;
    play.paused = on;
    if (on) {
      var ov = $('#overlay');
      ov.hidden = false; ov.textContent = ''; ov.style.background = '';
      ov.appendChild(h('div', { class: 'dialog', role: 'dialog', 'aria-label': '暫停' },
        h('h2', { text: '暫停' }),
        h('div', { class: 'dialog-btns' },
          dlgBtn('繼續', 'primary', function () { pauseSolo(false); }),
          dlgBtn('重新開始', '', function () { restartSolo(); }),
          dlgBtn('回到首頁', 'ghost', function () { leavePlay('home'); }))));
      var f = $('.dialog button', ov); if (f) f.focus();
    } else closeOverlay();
  }

  function dlgBtn(text, cls, fn, disabled) {
    var b = h('button', { class: 'btn ' + (cls || ''), type: 'button', text: text });
    if (disabled) { b.setAttribute('aria-disabled', 'true'); }
    b.addEventListener('click', function () { if (!disabled) fn(); });
    return b;
  }

  function restartSolo() {
    startPlay({ mode: 'solo', diff: play.diff, seed: (Math.random() * 4294967296) >>> 0 });
  }

  function leavePlay(to) {
    if (play && play.mode !== 'solo' && to === 'home') { Net.send({ type: 'leave' }); online.room = null; online.joined = false; }
    play = null;
    closeOverlay(); closeLeaveConfirm();
    if (to === 'home') Net.disconnect();
    go(to);
  }

  function showResult() {
    var p = play;
    if (!p) return;
    p.resultShown = true;
    renderResult();
  }

  function renderResult() {
    var p = play;
    if (!p || !p.resultShown) return;
    var ov = $('#overlay');
    ov.hidden = false; ov.textContent = ''; ov.style.background = '';
    var dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '結算' });
    var btns = h('div', { class: 'dialog-btns' });

    if (p.mode === 'solo') {
      var g = p.g;
      dlg.appendChild(h('h2', { text: g.overReason === 'time' ? '時間到！' : '球用完了' }));
      dlg.appendChild(h('div', { class: 'big-score', text: String(g.score) }));
      if (p.newBest) dlg.appendChild(h('div', { class: 'newbest', text: '新紀錄！' }));
      var st = Rules.summary(g);
      var stats = h('div', { class: 'stats' });
      [['難度', g.diff.name], ['進球', st.hoops], ['空心球', st.swishes], ['最高連擊', '×' + st.bestCombo], ['彈跳墊', st.bumps], ['用時', st.seconds + ' 秒']].forEach(function (r) {
        stats.appendChild(h('div', {}, h('span', { text: r[0] }), h('b', { text: String(r[1]) })));
      });
      dlg.appendChild(stats);
      btns.appendChild(dlgBtn('再來一局', 'primary', restartSolo));
      btns.appendChild(dlgBtn('回到房間', '', null, true));
      btns.appendChild(dlgBtn('回到首頁', 'ghost', function () { leavePlay('home'); }));
      dlg.appendChild(btns);
      dlg.appendChild(h('p', { class: 'note', text: '單機模式沒有房間，所以「回到房間」不能使用' }));
    } else {
      var room = online.room, ended = room && room.phase === 'ended';
      dlg.appendChild(h('h2', { text: ended ? '比賽結束' : '結算中…' }));
      var list = ended && room.result ? room.result.map(function (r) { return { id: r.id, name: r.name, score: r.score, place: r.place }; })
        : (room ? room.players.slice().sort(function (a, b) { return b.score - a.score; }).map(function (x, i) { return { id: x.id, name: x.name, score: x.score, place: i + 1 }; }) : []);
      var ol = h('ol', { class: 'rank' });
      list.forEach(function (r) {
        ol.appendChild(h('li', { class: room && r.id === room.you.id ? 'me' : '' }, h('span', { class: 'no', text: String(r.place) }), h('span', { text: r.name }), h('span', { class: 'sc', text: String(r.score) })));
      });
      dlg.appendChild(ol);
      var isPlayer = room && room.you.role === 'player';
      btns.appendChild(dlgBtn('再來一局', 'primary', function () { Net.send({ type: 'again' }); leavePlayToRoom(); }, !(ended && isPlayer)));
      btns.appendChild(dlgBtn('回到房間', '', function () { leavePlayToRoom(); }));
      btns.appendChild(dlgBtn('回到首頁', 'ghost', function () { leavePlay('home'); }));
      dlg.appendChild(btns);
      if (!ended) dlg.appendChild(h('p', { class: 'note', text: '等其他玩家打完，結束後才能再來一局' }));
      else if (!isPlayer) dlg.appendChild(h('p', { class: 'note', text: '觀戰者不能開新局' }));
    }
    ov.appendChild(dlg);
    var f = $('.dialog button:not([aria-disabled])', ov); if (f && document.activeElement && document.activeElement.tagName !== 'INPUT') f.focus();
  }

  function leavePlayToRoom() {
    closeOverlay();
    if (play) play.resultShown = false;
    go('room');
    renderRoom();
  }

  /* ---------- 聊天 ---------- */
  var QUICK = ['加油！', '好球！', '空心！', '再來一局', 'GG'];
  var chatLog = $('#chatLog'), unread = 0;
  QUICK.forEach(function (t) {
    var b = h('button', { type: 'button', text: t });
    b.addEventListener('click', function () { Net.send({ type: 'chat', text: t }); });
    $('#quick').appendChild(b);
  });
  $('#chatForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var inp = $('#chatInput');
    var t = inp.value.trim();
    if (t) Net.send({ type: 'chat', text: t });
    inp.value = '';
  });

  function placeChat() {
    var slot = screen === 'room' ? $('#roomChatSlot') : (screen === 'play' ? $('#panelChatSlot') : null);
    if (slot && online.joined) { if (chatEl.parentNode !== slot) slot.appendChild(chatEl); chatEl.hidden = false; }
    else { chatEl.hidden = true; }
  }
  function chatVisible() { return screen === 'room' || (screen === 'play' && panelOpen); }
  function clearUnread() { unread = 0; $('#unreadDot').hidden = true; $('#chatDot').hidden = true; }
  function addChat(m, silent) {
    var li = h('li', { class: m.role === 'spec' ? 'spec' : '' }, h('b', { text: m.name + (m.role === 'spec' ? '（觀戰）' : '') + '：' }), document.createTextNode(m.text));
    chatLog.appendChild(li);
    while (chatLog.children.length > 80) chatLog.removeChild(chatLog.firstChild);
    chatLog.scrollTop = chatLog.scrollHeight;
    if (!silent && online.room && m.id !== online.room.you.id) {
      sfx('chat');
      if (!chatVisible()) { unread++; $('#unreadDot').hidden = false; $('#chatDot').hidden = false; }
    }
  }
  Net.on('chat', function (m) { addChat(m.msg); });
  Net.on('chat_history', function (m) { chatLog.textContent = ''; (m.chat || []).forEach(function (x) { addChat(x, true); }); });

  /* ---------- 線上：大廳 ---------- */
  var online = { room: null, joined: false, role: null };
  var createDiff = 'normal', createListed = true;
  var invite = null;      /* { room, token, want } 來自網址的邀請 */

  function nick() { return ($('#nickInput').value || '').trim(); }

  function netLabel(state, info) {
    var el = $('#netState');
    var map = {
      open: ['已連線', 'ok'], connecting: ['連線中…', 'warn'], closed: ['連線中斷，重試中…', 'bad'],
      waking: ['喚醒伺服器中…（免費主機約需 30～60 秒）', 'warn'], idle: ['', ''],
      unavailable: ['這個網頁沒有設定伺服器，只能玩單機', 'bad']
    };
    var v = map[state] || ['', ''];
    el.textContent = v[0]; el.className = 'net-state ' + v[1];
    var can = state === 'open';
    $('#btnCreate').disabled = !can;
    $$('#roomList .btn').forEach(function (b) { b.disabled = !can; });
  }
  Net.onState(netLabel);

  function enterLobby() {
    $('#nickInput').value = Store.get('nick') || '';
    renderCreateDiff();
    if (!Config.serverUrl) { netLabel('unavailable'); if (Config.error) toast(Config.error, 5000); return; }
    Net.connect();
    netLabel(Net.getState());
    if (Net.isOpen()) Net.send({ type: 'hello', name: nick() });
    renderInvite();
  }

  $('#nickInput').addEventListener('change', function () { Store.set('nick', nick()); });

  function renderCreateDiff() {
    var box = $('#createDiff'); box.textContent = '';
    Rules.DIFF_LIST.forEach(function (id) {
      var b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(id === createDiff), text: Rules.DIFFS[id].name });
      b.addEventListener('click', function () { createDiff = id; renderCreateDiff(); sfx('ui'); });
      box.appendChild(b);
    });
    $('#createListed').setAttribute('aria-checked', String(createListed));
  }
  $('#createListed').addEventListener('click', function () { createListed = !createListed; renderCreateDiff(); sfx('ui'); });
  $('#btnCreate').addEventListener('click', function () {
    Store.set('nick', nick());
    Net.send({ type: 'create', name: nick(), difficulty: createDiff, listed: createListed });
  });

  Net.on('hello', function (m) {
    if (m.resumeRoom) Net.send({ type: 'resume', roomId: m.resumeRoom });
    else Net.send({ type: 'hello', name: nick() });
  });

  Net.on('lobby', function (m) { renderRooms(m.rooms || []); });
  function renderRooms(list) {
    var ul = $('#roomList'); ul.textContent = '';
    $('#roomEmpty').hidden = list.length > 0;
    var can = Net.getState() === 'open';
    list.forEach(function (r) {
      var canPlay = r.phase === 'lobby' && r.players < r.seats;
      var li = h('li', {},
        h('div', { class: 'info' }, h('b', { text: r.id }), h('small', { text: r.difficultyName + ' · ' + r.players + '/' + r.seats + ' 人' + (r.specs ? ' · 觀戰 ' + r.specs : '') + ' · ' + (r.phase === 'lobby' ? '等待中' : '對戰中') + ' · 房主 ' + r.host })));
      if (canPlay) li.appendChild(joinBtn('加入', 'primary', r.id, 'play'));
      li.appendChild(joinBtn('觀戰', '', r.id, 'watch'));
      ul.appendChild(li);
    });
  }
  function joinBtn(text, cls, id, want) {
    var b = h('button', { class: 'btn small ' + cls, type: 'button', text: text });
    b.disabled = Net.getState() !== 'open';
    b.addEventListener('click', function () {
      Store.set('nick', nick());
      Net.send({ type: 'join', roomId: id, name: nick(), want: want });
    });
    return b;
  }

  /* 邀請連結：不會自動用存好的暱稱進房，先停在大廳讓對方確認 */
  (function readInvite() {
    var q = new URLSearchParams(location.search);
    if (q.get('room') && q.get('inv')) {
      invite = { room: String(q.get('room')).toUpperCase().slice(0, 8), token: q.get('inv'), want: q.get('r') === 'watch' ? 'watch' : 'play' };
    }
  })();

  function renderInvite() {
    var box = $('#inviteCard');
    if (!invite) { box.hidden = true; return; }
    box.hidden = false; box.textContent = '';
    box.appendChild(h('h3', { text: '你被邀請了！' }));
    box.appendChild(h('p', { text: '房間 ' + invite.room + '（' + (invite.want === 'watch' ? '觀戰' : '一起玩') + '邀請）。確認暱稱後按「加入」。' }));
    var field = h('label', { class: 'field' }, h('span', { class: 'sr', text: '邀請用暱稱' }));
    var inp = h('input', { type: 'text', maxlength: '12', placeholder: '輸入暱稱（可留白）', value: Store.get('nick') || '' });
    field.appendChild(inp);
    var go = h('button', { class: 'btn primary', type: 'button', text: '加入' });
    go.disabled = Net.getState() !== 'open';
    go.addEventListener('click', function () {
      Store.set('nick', inp.value.trim());
      $('#nickInput').value = inp.value.trim();
      Net.send({ type: 'join', roomId: invite.room, name: inp.value.trim(), token: invite.token, want: invite.want });
    });
    var cancel = h('button', { class: 'btn small ghost', type: 'button', text: '先不要' });
    cancel.addEventListener('click', function () { clearInvite(); });
    box.appendChild(field);
    box.appendChild(h('div', { class: 'actions' }, go, cancel));
  }
  Net.onState(function () { if (invite) renderInvite(); });
  function clearInvite() {
    invite = null;
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* 忽略 */ }
    renderInvite();
  }
  if (invite) go('lobby');

  /* ---------- 線上：房間 ---------- */
  Net.on('joined', function (m) {
    online.joined = true; online.role = m.role;
    if (invite) clearInvite();
    var notes = {
      seats_full: '玩家席位已滿，你以觀戰者身分進房',
      match_running: '比賽進行中，你以觀戰者身分進房',
      resumed: '已重新連線'
    };
    if (m.notice && notes[m.notice]) toast(notes[m.notice], 3600);
    chatLog.textContent = '';
    if (!(play && play.mode !== 'solo' && play.roomId === m.roomId)) go('room');
  });

  Net.on('room', function (m) {
    online.room = m.room;
    if (!online.joined) { online.joined = true; }
    placeChat();
    var r = m.room;
    if (r.phase === 'playing') ensureOnlinePlay(r);
    else if (screen === 'play' && play && play.mode !== 'solo') {
      if (r.phase === 'ended') {
        if (play.mode === 'online' && !play.over) { play.over = true; onlineReport(true); }
        if (play.mode === 'spec' || !play.resultShown) { play.resultShown = true; sfx('win'); }
        renderResult();
      } else if (r.phase === 'lobby') { renderResult(); }
    }
    if (screen === 'room') renderRoom();
    if (screen === 'play') { updateSummary(); if (play && play.mode === 'spec') buildSpecTabs(); }
  });

  function ensureOnlinePlay(r) {
    if (play && play.mode !== 'solo' && play.roomId === r.id && play.round === r.round) return;
    var mode = (r.you.role === 'player' && !(online.resumed)) ? 'online' : 'spec';
    /* 已經有進行中的本機遊戲才算玩家；頁面重載後的玩家只能看 */
    if (mode === 'online' && r.startAt + Rules.DIFFS[r.difficulty].duration * 1000 < Net.serverNow()) mode = 'spec';
    if (mode === 'online' && Net.serverNow() - r.startAt > 4000) mode = 'spec';
    startPlay({ mode: mode, diff: r.difficulty, seed: r.seed, roomId: r.id, round: r.round, startAt: r.startAt });
  }

  Net.on('closed', function (m) {
    var reasons = { 'no-players': '房間裡已經沒有玩家，房間已關閉', room_closed: '這個房間已經結束了', not_member: '你已經不在這個房間了' };
    online.room = null; online.joined = false;
    play = play && play.mode === 'solo' ? play : null;
    closeOverlay(); closeSettings(); closeLeaveConfirm();
    if (invite) { clearInvite(); }
    chatEl.hidden = true;
    go('lobby');
    showNotice('房間已結束', reasons[m.reason] || '房間已關閉', '回到大廳');
  });
  Net.on('kicked', function () {
    online.room = null; online.joined = false; play = null; closeOverlay(); closeLeaveConfirm();
    go('lobby'); showNotice('你被請出房間', '房主把你請出了房間。', '回到大廳');
  });
  Net.on('error', function (m) {
    toast(m.text || '發生錯誤', 3800);
    if (invite && /^invite_|room_closed/.test(m.code || '')) {
      var card = $('#inviteCard');
      card.hidden = false; card.textContent = '';
      card.appendChild(h('h3', { text: '無法使用這個邀請' }));
      card.appendChild(h('p', { text: m.text }));
      var ok = h('button', { class: 'btn small', type: 'button', text: '知道了' });
      ok.addEventListener('click', function () { clearInvite(); });
      card.appendChild(h('div', { class: 'actions' }, ok));
      invite = null;
    }
  });

  function showNotice(title, text, btn) {
    if (document.getElementById('noticeModal')) return;
    var back = h('div', { class: 'modal-back', id: 'noticeModal' });
    var ok = h('button', { class: 'btn primary', type: 'button', text: btn || '知道了' });
    ok.addEventListener('click', function () { back.remove(); });
    back.appendChild(h('div', { class: 'modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', { text: title }), h('p', { text: text }), h('div', { class: 'actions' }, ok)));
    $('#modalRoot').appendChild(back);
    ok.focus();
  }

  function crown() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'crown'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z');
    svg.appendChild(path);
    return svg;
  }

  function seatEl(pl, room) {
    var meIsHost = room.you.isHost;
    var st = !pl.connected ? ['離線', 'off'] : pl.isHost ? ['房主', ''] : pl.ready ? ['已準備', 'ready'] : ['未準備', ''];
    var li = h('li', { class: 'seat' });
    if (pl.isHost) li.appendChild(crown());
    li.appendChild(h('span', { class: 'nm', text: pl.name + (pl.id === room.you.id ? '（你）' : '') }));
    if (pl.cpu) { st = [pl.skill || '電腦', 'ready']; }
    li.appendChild(h('span', { class: 'st ' + st[1], text: st[0] }));
    if (meIsHost && pl.id !== room.you.id && room.phase === 'lobby') {
      var k = h('button', { class: 'btn small ghost', type: 'button', text: pl.cpu ? '移除' : '請出' });
      k.addEventListener('click', function () { Net.send({ type: 'kick', id: pl.id }); });
      li.appendChild(k);
    }
    return li;
  }

  function renderRoom() {
    var room = online.room;
    if (!room || !room.you) return;
    var you = room.you, isHost = you.isHost, lobby = room.phase === 'lobby';
    $('#roomCode').textContent = room.id;
    $('#roleTag').textContent = you.role === 'player' ? (isHost ? '房主' : '玩家') : '觀戰者';

    var box = $('#roomDiff'); box.textContent = '';
    Rules.DIFF_LIST.forEach(function (id) {
      var b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(id === room.difficulty), text: Rules.DIFFS[id].name });
      b.disabled = !(isHost && lobby);
      b.addEventListener('click', function () { Net.send({ type: 'difficulty', value: id }); });
      box.appendChild(b);
    });
    $('#roomListed').setAttribute('aria-checked', String(room.listed));
    $('#roomListed').disabled = !isHost;
    $('#listedRow').hidden = !isHost;

    var seats = $('#seats'); seats.textContent = '';
    room.players.forEach(function (pl) { seats.appendChild(seatEl(pl, room)); });
    for (var i = room.players.length; i < room.seats; i++) {
      var es = h('li', { class: 'seat empty' }, h('span', { class: 'nm', text: '空位' }));
      if (isHost && lobby) {
        var pick = h('span', { class: 'cpu-pick', role: 'group', 'aria-label': '在這個空位加入電腦' }, h('small', { text: '加入電腦' }));
        [['easy', '新手'], ['normal', '一般'], ['hard', '高手']].forEach(function (k) {
          var cb = h('button', { type: 'button', class: 'btn small', text: k[1] });
          cb.addEventListener('click', function () { Net.send({ type: 'add_cpu', skill: k[0] }); });
          pick.appendChild(cb);
        });
        es.appendChild(pick);
      }
      seats.appendChild(es);
    }
    $('#seatCount').textContent = room.players.length + '/' + room.seats;
    $('#specLine').textContent = room.specs.length ? '觀戰中：' + room.specs.map(function (s) { return s.name; }).join('、') : '目前沒有觀戰者';

    var rc = $('#resultCard');
    rc.hidden = !(room.result && room.result.length);
    if (!rc.hidden) {
      var ol = $('#resultList'); ol.textContent = '';
      room.result.forEach(function (r) {
        ol.appendChild(h('li', { class: r.id === you.id ? 'me' : '' }, h('span', { class: 'no', text: String(r.place) }), h('span', { text: r.name }), h('span', { class: 'sc', text: String(r.score) })));
      });
    }

    var rb = $('#btnReady'), sb = $('#btnStart'), hint = $('#startHint');
    var live = room.players.filter(function (p) { return p.connected; });
    var allReady = live.every(function (p) { return p.isHost || p.ready; });
    rb.hidden = isHost || you.role !== 'player';
    var me = room.players.filter(function (p) { return p.id === you.id; })[0];
    rb.textContent = me && me.ready ? '取消準備' : '準備';
    rb.disabled = !lobby && room.phase !== 'ended';
    sb.hidden = !isHost;
    sb.disabled = !(lobby && live.length >= 2 && allReady);
    if (room.phase === 'ended') {
      hint.textContent = '比賽結束了。' + (you.role === 'player' ? '按「準備」開始下一局。' : '');
      if (you.role === 'player') { rb.hidden = false; rb.disabled = false; rb.textContent = '再來一局'; sb.hidden = true; }
    }
    else if (you.role === 'spec') hint.textContent = '你是觀戰者，比賽開始時會自動看到對戰畫面。';
    else if (isHost) hint.textContent = live.length < 2 ? '至少要 2 位玩家才能開始：傳邀請連結給朋友，或在空位上選「加入電腦」。' : (allReady ? '大家都準備好了，可以開始！' : '還有玩家沒有準備好。');
    else hint.textContent = '準備好之後，等房主按開始。';

    var ib = $('#inviteBox');
    ib.hidden = !(isHost && room.invite);
    if (!ib.hidden) { $('#linkPlay').textContent = inviteUrl('play'); $('#linkWatch').textContent = inviteUrl('watch'); }
    if (room.phase === 'ended') {
      /* 回到房間看結果時，這顆按鈕負責「再來一局」 */
    }
  }

  $('#btnReady').addEventListener('click', function () {
    var room = online.room; if (!room) return;
    if (room.phase === 'ended') { Net.send({ type: 'again' }); return; }
    var me = room.players.filter(function (p) { return p.id === room.you.id; })[0];
    Net.send({ type: 'ready', on: !(me && me.ready) });
  });
  $('#btnStart').addEventListener('click', function () { Net.send({ type: 'start' }); });
  $('#roomListed').addEventListener('click', function () { var r = online.room; if (r) Net.send({ type: 'listed', value: !r.listed }); });
  $('#btnRegen').addEventListener('click', function () { Net.send({ type: 'invite_regen' }); toast('舊連結已失效，已產生新的'); });
  $('#btnLeaveRoom').addEventListener('click', function () {
    Net.send({ type: 'leave' });
    online.room = null; online.joined = false; play = null;
    go('lobby');
  });

  function inviteUrl(role) {
    var room = online.room;
    var tok = room && room.invite && room.invite[role === 'watch' ? 'watch' : 'play'];
    if (!tok) return '';
    var u = location.origin + location.pathname + '?room=' + encodeURIComponent(room.id) + '&inv=' + encodeURIComponent(tok) + '&r=' + (role === 'watch' ? 'watch' : 'play');
    if (Config.source === 'query') u += '&server=' + encodeURIComponent(Config.serverUrl);
    return u;
  }
  function copy(text, okMsg) {
    function fallback() {
      var t = h('textarea', { style: 'position:fixed;left:-999px' });
      t.value = text; document.body.appendChild(t); t.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* 忽略 */ }
      t.remove(); toast(ok ? okMsg : '請手動複製：' + text, ok ? 2200 : 8000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
    else fallback();
  }
  $('#btnCopyPlay').addEventListener('click', function () { copy(inviteUrl('play'), '已複製玩家邀請連結'); });
  $('#btnCopyWatch').addEventListener('click', function () { copy(inviteUrl('watch'), '已複製觀戰邀請連結'); });

  /* ---------- 啟動 ---------- */
  applySettings();
  renderBest();
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && play && play.mode === 'solo' && play.running && !play.over && !play.paused) pauseSolo(true);
  });

  /* 給測試用的掛勾（不影響遊戲） */
  window.__ph = { get play() { return play; }, go: go, startPlay: startPlay, get online() { return online; }, layout: layout };
})();
