/* ===== app.js — 畫面、遊戲迴圈、設定視窗、線上房間與觀戰 ===== */
(function () {
  'use strict';

  var Rules = window.Rules, Store = window.Store, Audio = window.GameAudio;
  var Render = window.Render, Net = window.Net, Config = window.Config;
  var I18N = window.I18N;
  function T(k, p) { return I18N.t(k, p); }

  /* 伺服器內建的隨機暱稱與電腦名稱（順序要和 lib/rooms.js 的 ADJ / ANI 一致），顯示時才翻譯 */
  var ADJ = ['快速', '安靜', '閃亮', '勇敢', '圓圓', '跳跳', '神準', '穩穩', '火熱', '冰涼'];
  var ANI = ['小貓', '企鵝', '柴犬', '貓頭鷹', '海豹', '小熊', '狐狸', '河馬', '浣熊', '鴨鴨'];
  function pname(name) {
    name = String(name == null ? '' : name);
    if (I18N.lang === 'zh-Hant' || !name) return name;
    var m = /^電腦·(.+?)(\d*)$/.exec(name);
    if (m) { var ai = ANI.indexOf(m[1]); if (ai >= 0) return T('cpu.prefix') + T('ani.' + ai) + m[2]; }
    for (var a = 0; a < ADJ.length; a++) {
      if (name.indexOf(ADJ[a]) === 0) { var bi = ANI.indexOf(name.slice(ADJ[a].length)); if (bi >= 0) return T('adj.' + a) + T('ani.' + bi); }
    }
    return name;
  }
  function dn(id) { return T('diff.' + id + '.name'); }
  var SKILL_ID = { '新手': 'easy', '一般': 'normal', '高手': 'hard' };

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
    if (window.ServerOutage) window.ServerOutage.setScreen(name);
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
    var parts = Rules.DIFF_LIST.filter(function (d) { return b[d]; }).map(function (d) { return dn(d) + ' ' + b[d]; });
    $('#bestLine').textContent = parts.length ? T('home.best', { list: parts.join(T('sep.best')) }) : T('home.noBest');
    var r = Store.get('records') || {};
    $('#recordLine').textContent = T('records.stats', { games: r.games || 0, hoops: r.hoops || 0, swishes: r.swishes || 0, combo: r.bestCombo || 0 });
    var achievements = [];
    if (r.hoops >= 1) achievements.push(T('records.first'));
    if (r.swishes >= 10) achievements.push(T('records.swish'));
    if (r.bestCombo >= 5) achievements.push(T('records.combo'));
    if (r.games >= 10) achievements.push(T('records.games'));
    $('#achievementLine').textContent = T('records.achievements', { list: achievements.length ? achievements.join(T('sep.best')) : T('records.none') });
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
        h('b', { text: dn(id) }), h('span', { text: T('diff.' + id + '.blurb') }),
        h('em', { text: best[id] ? T('diff.best', { n: best[id] }) : T('diff.none') }));
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

  function sw(labelKey, key, onChange) {
    var label = T(labelKey);
    var btn = h('button', { class: 'sw', type: 'button', role: 'switch', 'aria-checked': String(!!Store.get(key)), 'aria-label': label }, h('i'));
    btn.addEventListener('click', function () {
      var on = btn.getAttribute('aria-checked') !== 'true';
      btn.setAttribute('aria-checked', String(on));
      Store.set(key, on); applySettings(); sfx('ui');
      if (onChange) onChange(on);
    });
    return h('div', { class: 'row' }, h('span', { text: label }), btn);
  }

  function meter(volKey, key) {
    var label = T(volKey);
    var box = h('div', { class: 'meter', role: 'group', 'aria-label': label });
    function paint() {
      $$('button', box).forEach(function (b, i) { b.classList.toggle('on', i < Store.get(key)); });
    }
    for (var i = 1; i <= 5; i++) {
      (function (n) {
        var b = h('button', { type: 'button', 'aria-label': T(volKey + 'N', { n: n }) });
        b.addEventListener('click', function () {
          Store.set(key, Store.get(key) === n ? n - 1 : n);
          applySettings(); paint(); sfx('bump');
        });
        box.appendChild(b);
      })(i);
    }
    paint();
    return h('div', { class: 'row' }, h('span', { text: label }), box);
  }

  function openSettings(opener) {
    if (document.getElementById('settingsModal')) return;
    modalOpener = opener || document.activeElement;
    var wasRunning = play && play.mode === 'solo' && play.running && !play.paused && !play.over;
    if (wasRunning) pauseSolo(true);

    var back = h('div', { class: 'modal-back', id: 'settingsModal' });
    var dlg = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'setTitle' });
    dlg.appendChild(h('h2', { id: 'setTitle', text: T('set.title') }));
    dlg.appendChild(sw('set.music', 'musicOn'));
    dlg.appendChild(meter('set.musicVol', 'musicLevel'));
    dlg.appendChild(sw('set.sfx', 'sfxOn', function (on) { if (on) sfx('bump'); }));
    dlg.appendChild(meter('set.sfxVol', 'sfxLevel'));
    dlg.appendChild(sw('set.vibrate', 'vibrate', function (on) { if (on) vibrate(30); }));
    dlg.appendChild(sw('set.reduce', 'reduceMotion'));
    dlg.appendChild(sw('set.contrast', 'contrast'));
    dlg.appendChild(sw('set.hints', 'showHints'));
    dlg.appendChild(sw('set.timing', 'timingHint'));

    var btns = h('div', { class: 'actions' });
    var reset = h('button', { class: 'btn small ghost', type: 'button', text: T('set.reset') });
    reset.addEventListener('click', function () { Store.reset(); applySettings(); closeSettings(); openSettings(modalOpener); toast(T('toast.reset')); });
    var close = h('button', { class: 'btn small primary', type: 'button', text: T('set.close') });
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

  var oppW = 0, oppGap = 0;
  function layout() {
    var wrap = $('#cvWrap');
    if (!wrap) return;
    var w = wrap.clientWidth, hgt = wrap.clientHeight;
    if (w < 40 || hgt < 40) return;
    var n = play && play.mode === 'online' ? Object.keys(play.opps).length : 0;
    oppW = 0;
    if (n) {
      /* 對手視窗：靠右一欄，寬度不超過整體 26%，高度要塞得下 n 個 */
      oppW = Math.max(48, Math.min(Math.floor(w * 0.26), 190, Math.floor((hgt - 4 - (n - 1) * 8 - n * 20) / n * 2 / 3)));
      oppGap = w >= 700 ? 28 : 16;
      $('#oppCol').style.marginLeft = oppGap + 'px';
      w -= oppW + oppGap;
    }
    var cw = Math.floor(Math.min(w - 4, (hgt - 4) * 2 / 3));
    var ch = Math.floor(cw * 1.5);
    rend.resize(cw, ch, Math.min(window.devicePixelRatio || 1, 2.5));
    Object.keys(play && play.opps || {}).forEach(function (id) {
      var o = play.opps[id];
      o.rend.resize(oppW, Math.round(oppW * 1.5), Math.min(window.devicePixelRatio || 1, 2));
      o.el.style.width = oppW + 'px';
    });
  }
  window.addEventListener('resize', function () { layout(); applyPanelMode(); });
  window.addEventListener('orientationchange', function () { setTimeout(function () { layout(); applyPanelMode(); }, 200); });
  if (window.ResizeObserver) new ResizeObserver(layout).observe($('#cvWrap'));

  function startLoop() { if (!raf) { lastTs = 0; raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  function startPlay(o) {
    if (o.mode !== 'spec') GameAnalytics.start({
      mode: o.mode, difficulty: o.diff, players: o.players || 1
    }, o.mode === 'online' ? o.roomId + '|' + o.round : null);
    closeOverlay();
    rend.reset();
    var online = o.mode === 'online' || o.mode === 'spec';
    play = {
      mode: o.mode, diff: o.diff, seed: o.seed, roomId: o.roomId || null, round: o.round || 0,
      g: o.mode === 'spec' ? null : Rules.create(o.diff, o.seed, o.mode === 'online'),
      startAt: o.startAt || 0, cd: 3, cdShown: 0, running: false, paused: false, over: false,
      lastReport: 0, lastSnap: 0, lastScore: -1, resultShown: false, newBest: false,
      focus: null, disp: null, snaps: {}, opps: {}, oppKey: ''
    };
    $('#oppCol').textContent = '';
    app.dataset.online = online ? '1' : '0';
    app.dataset.solo = online ? '0' : '1';
    app.dataset.spectator = o.mode === 'spec' ? '1' : '0';
    pauseLabel();
    if (o.mode === 'spec') { play.running = true; buildSpecTabs(); }
    go('play');
    if (o.mode === 'online') buildOpps();
    applyPanelMode(true);
    updateHud(true);
    updateSummary();
  }

  function pauseLabel() {
    if (!play) return;
    $('#btnPause').textContent = play.mode === 'solo' ? T('play.pause') : T('common.leave');
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
    opts.timingHint = !!Store.get('timingHint');
    rend.draw(Rules.view(g), opts);
    if (p.mode === 'online') drawOpps(dt);
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
    if (!play.mode || play.mode !== 'spec') { rend.pop(300, 420, T('pop.start'), '#ffe14d'); }
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
          rend.pop(Math.min(g.hoopX, 470), g.hoopY + 56, '+' + e.points + (e.swish ? T('pop.swish') : ''), e.swish ? '#22e4ff' : '#ffe14d');
          vibrate(e.swish ? [30, 40, 30] : 30);
          onlineReportSoon();
          break;
        case 'drain':
          sfx('drain'); vibrate(80);
          rend.pop(300, 800, !g.unlimited && g.diff.balls > 0 && g.ballNo >= g.diff.balls ? T('pop.ballsOut') : T('pop.drain'), '#ff3d9a');
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
      Store.recordGame(Rules.summary(g));
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
    if (online.room && now - p.lastSnap > 100) {
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
    return smoothView(d, s, dt, room);
  }

  /** 把收到的快照（10 次/秒）平滑成每幀的畫面；觀戰與對手視窗共用 */
  function smoothView(d, s, dt, room) {
    var k = Math.min(1, dt * 18);
    if (s.b) {
      if (!d.ball || !d.init) { d.x = s.b[0]; d.y = s.b[1]; d.init = true; }
      d.x += (s.b[0] - d.x) * k; d.y += (s.b[1] - d.y) * k; d.spin = s.b[2];
      d.ball = true;
    } else d.ball = false;
    d.hy += (s.h - d.hy) * k; d.f0 += (s.f[0] - d.f0) * k;
    return { diff: room.difficulty, ball: d.ball ? { x: d.x, y: d.y, spin: d.spin } : null, fl: [d.f0], hx: Rules.geometry(room.difficulty).hoop.x, hy: d.hy, score: s.s, combo: s.c, ballNo: 0, t: 0 };
  }

  /* ---------- 對戰時看到對手的畫面（仿 rainbow-bubble 的對手欄） ---------- */
  function buildOpps() {
    var p = play, room = online.room, box = $('#oppCol');
    if (!p || p.mode !== 'online' || !room) return;
    var others = room.players.filter(function (x) { return x.id !== room.you.id; });
    var key = others.map(function (x) { return x.id; }).join('|');
    if (key === p.oppKey) return;
    p.oppKey = key;
    box.textContent = '';
    p.opps = {};
    others.forEach(function (pl) {
      var c = h('canvas', { 'aria-label': T('play.oppOf', { name: pname(pl.name) }) });
      var nameEl = h('span', { class: 'opp-name', text: pname(pl.name) });
      var scoreEl = h('b', { class: 'opp-score', text: '0' });
      var el = h('div', { class: 'opp' }, h('div', { class: 'opp-tag' }, nameEl, scoreEl), c);
      box.appendChild(el);
      p.opps[pl.id] = { el: el, canvas: c, plName: pl.name, nameEl: nameEl, rend: Render.create(c), scoreEl: scoreEl, disp: { id: pl.id, x: 0, y: 0, hy: 260, f0: Rules.REST, init: false, ball: null, spin: 0 }, score: -1 };
    });
    layout();
  }

  function drawOpps(dt) {
    var p = play, room = online.room;
    if (!room) return;
    Object.keys(p.opps).forEach(function (id) {
      var o = p.opps[id], s = p.snaps[id];
      var view = s ? smoothView(o.disp, s, dt, room) : { diff: room.difficulty, ball: null, fl: [Rules.REST], hx: Rules.geometry(room.difficulty).hoop.x, hy: Rules.geometry(room.difficulty).hoop.cy, score: 0, combo: 0, ballNo: 0, t: 0 };
      if (s && o.score !== s.s) { o.score = s.s; o.scoreEl.textContent = String(s.s); }
      o.rend.draw(view, { reduceMotion: true, contrast: false, pressed: [view.fl[0] < Rules.REST - 0.2] });
    });
  }

  function buildSpecTabs() {
    var box = $('#specTabs');
    box.textContent = '';
    if (!play || play.mode !== 'spec' || !online.room) return;
    online.room.players.forEach(function (pl) {
      var b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(play.focus === pl.id), text: pname(pl.name) });
      b.addEventListener('click', function () { play.focus = pl.id; play.disp = null; buildSpecTabs(); sfx('ui'); });
      box.appendChild(b);
    });
  }

  Net.on('snaps', function (m) {
    if (!play || play.mode === 'solo') return;
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
    ce.hidden = combo < 1;
    if (combo >= 1) setText('hComboN', String(combo));
    $('#hComboTime').hidden = p.mode === 'spec';
    if (p.mode !== 'spec' && combo) setText('hComboTime', Math.max(0, Rules.COMBO_WINDOW - (g.t - g.lastScoreT)).toFixed(1) + 's');
    $('#hBonus').hidden = p.mode === 'spec' || !Rules.bonusActive(g.t);
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
      box.appendChild(h('h4', { text: T('sum.solo', { diff: dn(g.diff.id) }) }));
      [[T('sum.best'), best], [T('sum.hoops'), g.hoops], [T('sum.swishes'), g.swishes], [T('sum.bestCombo'), '×' + g.bestCombo], [T('sum.bumps'), g.bumps]].forEach(function (r) {
        box.appendChild(h('div', { class: 'kv' }, h('span', { text: r[0] }), h('b', { text: String(r[1]) })));
      });
      box.appendChild(h('p', { class: 'muted', text: T('sum.hint') }));
      return;
    }
    var room = online.room;
    if (!room) return;
    box.appendChild(h('h4', { text: T('sum.room', { id: room.id, diff: dn(room.difficulty) }) }));
    var ol = h('ol', { class: 'rank' });
    room.players.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (pl, i) {
      ol.appendChild(h('li', { class: pl.id === room.you.id ? 'me' : '' },
        h('span', { class: 'no', text: String(i + 1) }), h('span', { text: pname(pl.name) + (pl.connected ? '' : T('sum.offline')) }), h('span', { class: 'sc', text: String(pl.score) })));
    });
    box.appendChild(ol);
    if (room.specs.length) box.appendChild(h('p', { class: 'muted', text: T('sum.specs', { n: room.specs.length }) }));
    if (room.you.role === 'spec') box.appendChild(h('p', { class: 'muted', text: T('sum.youSpec') }));
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
    var stay = h('button', { class: 'btn primary', type: 'button', text: T('leave.stay') });
    var quit = h('button', { class: 'btn ghost', type: 'button', text: T('common.leave') });
    stay.addEventListener('click', close);
    quit.addEventListener('click', function () { close(); leavePlay('home'); });
    back.appendChild(h('div', { class: 'modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': T('leave.aria') },
      h('h2', { text: T('leave.title') }),
      h('p', { class: 'muted', text: isSpec ? T('leave.bodySpec') : T('leave.bodyPlayer') }),
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
      renderPause();
      var f = $('#overlay .dialog button'); if (f) f.focus();
    } else closeOverlay();
  }

  function renderPause() {
    var ov = $('#overlay');
    ov.hidden = false; ov.textContent = ''; ov.style.background = '';
    ov.appendChild(h('div', { class: 'dialog', role: 'dialog', 'aria-label': T('pause.title') },
      h('h2', { text: T('pause.title') }),
      h('div', { class: 'dialog-btns' },
        dlgBtn(T('pause.resume'), 'primary', function () { pauseSolo(false); }),
        dlgBtn(T('pause.restart'), '', function () { restartSolo(); }),
        dlgBtn(T('pause.home'), 'ghost', function () { leavePlay('home'); }))));
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
    $('#oppCol').textContent = '';
    closeOverlay(); closeLeaveConfirm();
    if (to === 'home') Net.disconnect();
    go(to);
  }

  function showResult() {
    if (play && play.mode === 'solo') GameAnalytics.end({ result: 'complete' });
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
    var dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': T('res.aria'), 'data-result-share': '' });
    var btns = h('div', { class: 'dialog-btns' });

    if (p.mode === 'solo') {
      var g = p.g;
      dlg.appendChild(h('h2', { text: g.overReason === 'time' ? T('res.timeUp') : T('res.ballsOut') }));
      dlg.appendChild(h('div', { class: 'big-score', text: String(g.score) }));
      if (p.newBest) dlg.appendChild(h('div', { class: 'newbest', text: T('res.newBest') }));
      var st = Rules.summary(g);
      var stats = h('div', { class: 'stats' });
      [[T('res.diff'), dn(g.diff.id)], [T('sum.hoops'), st.hoops], [T('sum.swishes'), st.swishes], [T('sum.bestCombo'), '×' + st.bestCombo], [T('sum.bumps'), st.bumps], [T('res.time'), T('res.seconds', { n: st.seconds })]].forEach(function (r) {
        stats.appendChild(h('div', {}, h('span', { text: r[0] }), h('b', { text: String(r[1]) })));
      });
      dlg.appendChild(stats);
      btns.appendChild(dlgBtn(T('res.again'), 'primary', restartSolo));
      btns.appendChild(dlgBtn(T('res.toRoom'), '', null, true));
      btns.appendChild(dlgBtn(T('res.home'), 'ghost', function () { leavePlay('home'); }));
      dlg.appendChild(btns);
      dlg.appendChild(h('p', { class: 'note', text: T('res.soloNote') }));
    } else {
      var room = online.room, phase = room && room.phase;
      /* 有人先按「再來一局」房間就回到等待狀態：還停在結算的人也要能按「再來一局」（＝準備），不能卡在「結算中」 */
      var ended = phase === 'ended' || phase === 'lobby';
      if (phase === 'ended' && room.result) p.lastResult = room.result;
      dlg.appendChild(h('h2', { text: ended ? T('res.over') : T('res.pending') }));
      var final = phase === 'ended' ? room.result : (phase === 'lobby' ? p.lastResult : null);
      var list = final ? final.map(function (r) { return { id: r.id, name: r.name, score: r.score, place: r.place }; })
        : (room ? room.players.slice().sort(function (a, b) { return b.score - a.score; }).map(function (x, i) { return { id: x.id, name: x.name, score: x.score, place: i + 1 }; }) : []);
      var ol = h('ol', { class: 'rank' });
      list.forEach(function (r) {
        ol.appendChild(h('li', { class: room && r.id === room.you.id ? 'me' : '' }, h('span', { class: 'no', text: String(r.place) }), h('span', { text: pname(r.name) }), h('span', { class: 'sc', text: String(r.score) })));
      });
      dlg.appendChild(ol);
      var isPlayer = room && room.you.role === 'player';
      btns.appendChild(dlgBtn(T('res.again'), 'primary', function () { Net.send({ type: 'again' }); leavePlayToRoom(); }, !(ended && isPlayer)));
      btns.appendChild(dlgBtn(T('res.toRoom'), '', function () { leavePlayToRoom(); }));
      btns.appendChild(dlgBtn(T('res.home'), 'ghost', function () { leavePlay('home'); }));
      dlg.appendChild(btns);
      if (!ended) dlg.appendChild(h('p', { class: 'note', text: T('res.waitOthers') }));
      else if (!isPlayer) dlg.appendChild(h('p', { class: 'note', text: T('res.specNoNew') }));
      else if (phase === 'lobby') dlg.appendChild(h('p', { class: 'note', text: T('res.lobbyNote') }));
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
  var QUICK = ['chat.q1', 'chat.q2', 'chat.q3', 'chat.q4', 'chat.q5'];
  var chatLog = $('#chatLog'), unread = 0;
  function buildQuick() {
    var box = $('#quick'); box.textContent = '';
    QUICK.forEach(function (k) {
      var b = h('button', { type: 'button', text: T(k) });
      b.addEventListener('click', function () { Net.send({ type: 'chat', text: T(k) }); });
      box.appendChild(b);
    });
  }
  buildQuick();
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
    var li = h('li', { class: m.role === 'spec' ? 'spec' : '' }, h('b', { text: pname(m.name) + (m.role === 'spec' ? T('chat.spec') : '') + T('chat.colon') }), document.createTextNode(m.text));
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

  var lastNet = ['idle'];
  var lobbyOnlineCount = null;
  function netLabel(state, info) {
    lastNet = [state, info];
    if (state !== 'open') lobbyOnlineCount = null;
    paintLobbyCount();
    var el = $('#netState');
    var map = {
      open: ['net.open', 'ok'], connecting: ['net.connecting', 'warn'], closed: ['net.closed', 'bad'],
      waking: ['net.waking', 'warn'], idle: ['', ''],
      unavailable: ['net.unavailable', 'bad']
    };
    var v = map[state] || ['', ''];
    el.textContent = v[0] ? T(v[0]) : ''; el.className = 'net-state ' + v[1];
    var can = state === 'open';
    $('#btnCreate').disabled = !can;
    $$('#roomList .btn').forEach(function (b) { b.disabled = !can; });
  }
  Net.onState(netLabel);

  function enterLobby() {
    $('#nickInput').value = Store.get('nick') || '';
    renderCreateDiff();
    if (!Config.serverUrl) { netLabel('unavailable'); if (Config.error) toast(I18N.t('err.' + Config.errorCode, undefined, Config.error), 5000); return; }
    Net.connect();
    netLabel(Net.getState());
    if (Net.isOpen()) Net.send({ type: 'hello', name: nick() });
    renderInvite();
  }

  $('#nickInput').addEventListener('change', function () { Store.set('nick', nick()); });

  function renderCreateDiff() {
    var box = $('#createDiff'); box.textContent = '';
    Rules.DIFF_LIST.forEach(function (id) {
      var b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(id === createDiff), text: dn(id) });
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

  Net.on('lobby', function (m) {
    lobbyOnlineCount = Number.isInteger(m.online) && m.online >= 0 ? m.online : null;
    renderRooms(m.rooms || []);
  });
  var lastRooms = [];
  function paintLobbyCount() {
    var count = $('#onlineCount');
    var validOnline = Number.isInteger(lobbyOnlineCount);
    count.hidden = !validOnline;
    count.textContent = validOnline ? T('lobby.onlineCount', { n: lobbyOnlineCount }) : '';
  }
  function renderRooms(list) {
    lastRooms = list;
    paintLobbyCount();
    var ul = $('#roomList'); ul.textContent = '';
    $('#roomEmpty').hidden = list.length > 0;
    var can = Net.getState() === 'open';
    list.forEach(function (r) {
      var canPlay = r.phase === 'lobby' && r.players < r.seats;
      var li = h('li', {},
        h('div', { class: 'info' }, h('b', { text: r.id }), h('small', { text: [dn(r.difficulty), T('rooms.people', { n: r.players, m: r.seats }), r.specs ? T('rooms.specs', { n: r.specs }) : null, r.phase === 'lobby' ? T('rooms.waiting') : T('rooms.playing'), T('rooms.host', { name: pname(r.host) })].filter(Boolean).join(' · ') })));
      if (canPlay) li.appendChild(joinBtn(T('rooms.join'), 'primary', r.id, 'play'));
      li.appendChild(joinBtn(T('rooms.watch'), '', r.id, 'watch'));
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
    box.appendChild(h('h3', { text: T('inv.title') }));
    box.appendChild(h('p', { text: T('inv.body', { room: invite.room, kind: T(invite.want === 'watch' ? 'inv.kindWatch' : 'inv.kindPlay') }) }));
    var field = h('label', { class: 'field' }, h('span', { class: 'sr', text: T('inv.nickLabel') }));
    var prev = $('#inviteNick');
    var inp = h('input', { id: 'inviteNick', type: 'text', maxlength: '12', placeholder: T('nick.ph'), value: prev ? prev.value : (Store.get('nick') || '') });
    field.appendChild(inp);
    var go = h('button', { class: 'btn primary', type: 'button', text: T('inv.join') });
    go.disabled = Net.getState() !== 'open';
    go.addEventListener('click', function () {
      Store.set('nick', inp.value.trim());
      $('#nickInput').value = inp.value.trim();
      Net.send({ type: 'join', roomId: invite.room, name: inp.value.trim(), token: invite.token, want: invite.want });
    });
    var cancel = h('button', { class: 'btn small ghost', type: 'button', text: T('inv.skip') });
    cancel.addEventListener('click', function () { clearInvite(); });
    box.appendChild(field);
    box.appendChild(h('div', { class: 'actions' }, go, cancel));
  }
  Net.onState(function () { if (invite) renderInvite(); });
  var inviteErr = null;
  function clearInvite() {
    invite = null; inviteErr = null;
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* 忽略 */ }
    renderInvite();
  }
  if (invite) go('lobby');

  /* ---------- 線上：房間 ---------- */
  Net.on('joined', function (m) {
    online.joined = true; online.role = m.role;
    if (invite) clearInvite();
    if (m.notice && /^(seats_full|match_running|resumed)$/.test(m.notice)) toast(T('notice.' + m.notice), 3600);
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
        if (play.mode === 'online') GameAnalytics.end({ result: 'complete' });
        if (play.mode === 'online' && !play.over) { play.over = true; onlineReport(true); }
        if (play.mode === 'spec' || !play.resultShown) { play.resultShown = true; sfx('win'); }
        renderResult();
      } else if (r.phase === 'lobby') { renderResult(); }
    }
    if (screen === 'room') renderRoom();
    if (screen === 'play') { updateSummary(); if (play && play.mode === 'spec') buildSpecTabs(); if (play && play.mode === 'online') buildOpps(); }
  });

  function ensureOnlinePlay(r) {
    if (play && play.mode !== 'solo' && play.roomId === r.id && play.round === r.round) return;
    var mode = (r.you.role === 'player' && !(online.resumed)) ? 'online' : 'spec';
    /* 已經有進行中的本機遊戲才算玩家；頁面重載後的玩家只能看 */
    if (mode === 'online' && r.startAt + Rules.DIFFS[r.difficulty].duration * 1000 < Net.serverNow()) mode = 'spec';
    if (mode === 'online' && Net.serverNow() - r.startAt > 4000) mode = 'spec';
    startPlay({ mode: mode, diff: r.difficulty, seed: r.seed, roomId: r.id, round: r.round, startAt: r.startAt, players: r.players.length });
  }

  Net.on('closed', function (m) {
    online.room = null; online.joined = false;
    play = play && play.mode === 'solo' ? play : null;
    closeOverlay(); closeSettings(); closeLeaveConfirm();
    if (invite) { clearInvite(); }
    chatEl.hidden = true;
    go('lobby');
    showNotice('closed.title', I18N.t('closed.' + m.reason, undefined, '') ? 'closed.' + m.reason : 'closed.default', 'closed.back');
  });
  Net.on('kicked', function () {
    online.room = null; online.joined = false; play = null; closeOverlay(); closeLeaveConfirm();
    go('lobby'); showNotice('kicked.title', 'kicked.body', 'closed.back');
  });
  Net.on('error', function (m) {
    toast(errText(m), 3800);
    if (invite && /^invite_|room_closed/.test(m.code || '')) {
      inviteErr = m;
      invite = null;
      renderInviteErr();
    }
  });

  function errText(m) {
    var v = m.code ? I18N.t('err.' + m.code, undefined, '') : '';
    return v || m.text || T('toast.error');
  }
  function renderInviteErr() {
    if (!inviteErr) return;
    var card = $('#inviteCard');
    card.hidden = false; card.textContent = '';
    card.appendChild(h('h3', { text: T('inv.badTitle') }));
    card.appendChild(h('p', { text: errText(inviteErr) }));
    var ok = h('button', { class: 'btn small', type: 'button', text: T('common.ok') });
    ok.addEventListener('click', function () { clearInvite(); });
    card.appendChild(h('div', { class: 'actions' }, ok));
  }

  var lastNotice = null;
  function showNotice(titleKey, textKey, btnKey) {
    if (document.getElementById('noticeModal')) return;
    lastNotice = [titleKey, textKey, btnKey];
    var title = T(titleKey), text = T(textKey);
    var back = h('div', { class: 'modal-back', id: 'noticeModal' });
    var ok = h('button', { class: 'btn primary', type: 'button', text: btnKey ? T(btnKey) : T('common.ok') });
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
    var st = !pl.connected ? [T('seat.off'), 'off'] : pl.isHost ? [T('seat.host'), ''] : pl.ready ? [T('seat.ready'), 'ready'] : [T('seat.notReady'), ''];
    var li = h('li', { class: 'seat' });
    if (pl.isHost) li.appendChild(crown());
    li.appendChild(h('span', { class: 'nm', text: pname(pl.name) + (pl.id === room.you.id ? T('seat.you') : '') }));
    if (pl.cpu) { st = [SKILL_ID[pl.skill] ? T('skill.' + SKILL_ID[pl.skill]) : (pl.skill || T('seat.cpu')), 'ready']; }
    li.appendChild(h('span', { class: 'st ' + st[1], text: st[0] }));
    if (meIsHost && pl.id !== room.you.id && room.phase === 'lobby') {
      var k = h('button', { class: 'btn small ghost', type: 'button', text: pl.cpu ? T('seat.remove') : T('seat.kick') });
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
    $('#roleTag').textContent = you.role === 'player' ? (isHost ? T('role.host') : T('role.player')) : T('role.spec');

    var box = $('#roomDiff'); box.textContent = '';
    Rules.DIFF_LIST.forEach(function (id) {
      var b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(id === room.difficulty), text: dn(id) });
      b.disabled = !(isHost && lobby);
      b.addEventListener('click', function () { Net.send({ type: 'difficulty', value: id }); });
      box.appendChild(b);
    });
    $('#roomListed').setAttribute('aria-checked', String(room.listed));
    $('#roomListed').disabled = !isHost;
    $('#listedRow').hidden = !isHost;

    var seats = $('#seats'); seats.textContent = '';
    var bySeat = {};
    room.players.forEach(function (pl, idx) { bySeat[pl.seat == null ? idx : pl.seat] = pl; });
    for (var i = 0; i < room.seats; i++) {
      if (bySeat[i]) { seats.appendChild(seatEl(bySeat[i], room)); continue; }
      var es = h('li', { class: 'seat empty' }, h('span', { class: 'nm', text: T('seat.empty') }));
      if (isHost && lobby) {
        var pick = h('span', { class: 'cpu-pick', role: 'group', 'aria-label': T('seat.addCpuAria') }, h('small', { text: T('seat.addCpu') }));
        [['easy', T('skill.easy')], ['normal', T('skill.normal')], ['hard', T('skill.hard')]].forEach(function (k) {
          var cb = h('button', { type: 'button', class: 'btn small', text: k[1] });
          (function (seatNo) { cb.addEventListener('click', function () { Net.send({ type: 'add_cpu', skill: k[0], seat: seatNo }); }); })(i);
          pick.appendChild(cb);
        });
        es.appendChild(pick);
      }
      seats.appendChild(es);
    }
    $('#seatCount').textContent = room.players.length + '/' + room.seats;
    $('#specLine').textContent = room.specs.length ? T('room.specsLine', { names: room.specs.map(function (s) { return pname(s.name); }).join(T('sep.list')) }) : T('room.noSpecs');

    var rc = $('#resultCard');
    rc.hidden = !(room.result && room.result.length);
    if (!rc.hidden) {
      var ol = $('#resultList'); ol.textContent = '';
      room.result.forEach(function (r) {
        ol.appendChild(h('li', { class: r.id === you.id ? 'me' : '' }, h('span', { class: 'no', text: String(r.place) }), h('span', { text: pname(r.name) }), h('span', { class: 'sc', text: String(r.score) })));
      });
    }

    var rb = $('#btnReady'), sb = $('#btnStart'), hint = $('#startHint');
    var live = room.players.filter(function (p) { return p.connected; });
    var allReady = live.every(function (p) { return p.isHost || p.ready; });
    rb.hidden = isHost || you.role !== 'player';
    var me = room.players.filter(function (p) { return p.id === you.id; })[0];
    rb.textContent = me && me.ready ? T('room.unready') : T('room.ready');
    rb.disabled = !lobby && room.phase !== 'ended';
    sb.hidden = !isHost;
    sb.disabled = !(lobby && live.length >= 2 && allReady);
    if (room.phase === 'ended') {
      hint.textContent = T('hint.ended') + (you.role === 'player' ? T('hint.endedPlayer') : '');
      if (you.role === 'player') { rb.hidden = false; rb.disabled = false; rb.textContent = T('room.again'); sb.hidden = true; }
    }
    else if (you.role === 'spec') hint.textContent = T('hint.spec');
    else if (isHost) hint.textContent = live.length < 2 ? T('hint.hostNeed') : (allReady ? T('hint.hostGo') : T('hint.hostWait'));
    else hint.textContent = T('hint.player');

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
  $('#btnRegen').addEventListener('click', function () { Net.send({ type: 'invite_regen' }); toast(T('toast.regen')); });
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
      t.remove(); toast(ok ? okMsg : T('toast.copyManual', { text: text }), ok ? 2200 : 8000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
    else fallback();
  }
  $('#btnCopyPlay').addEventListener('click', function () { copy(inviteUrl('play'), T('toast.copyPlay')); });
  $('#btnCopyWatch').addEventListener('click', function () { copy(inviteUrl('watch'), T('toast.copyWatch')); });

  /* ---------- 語言切換：重繪動態文字（不重置遊戲狀態） ---------- */
  I18N.mountToggle({ after: $('#btnSettings') });
  /* 「回遊戲大廳」連結帶上 ?lang=，跨來源也能同步語言 */
  var lobbyLink = $('#lobbyLink'), lobbyBase = lobbyLink.getAttribute('href');
  function syncLobbyLink() { lobbyLink.setAttribute('href', I18N.withLang(lobbyBase)); }
  syncLobbyLink();
  I18N.onChange(function () {
    syncLobbyLink();
    renderBest();
    if (screen === 'solo') renderSoloDiffs();
    if (screen === 'lobby') { renderCreateDiff(); renderRooms(lastRooms); netLabel(lastNet[0], lastNet[1]); }
    if (invite) renderInvite(); else renderInviteErr();
    buildQuick();
    if (online.room && screen === 'room') renderRoom();
    pauseLabel();
    if (play) {
      updateSummary();
      Object.keys(play.opps || {}).forEach(function (id) {
        var o = play.opps[id];
        if (o.canvas) o.canvas.setAttribute('aria-label', T('play.oppOf', { name: pname(o.plName) }));
        if (o.nameEl) o.nameEl.textContent = pname(o.plName);
        if (o.rend) o.rend.bg = null;
      });
      if (play.mode === 'spec') buildSpecTabs();
      var ovDlg = $('#overlay .dialog');
      if (ovDlg) { if (play.resultShown) renderResult(); else if (play.paused && play.mode === 'solo') { renderPause(); var pf = $('#overlay .dialog button'); if (pf) pf.focus(); } }
    }
    rend.bg = null;
    var sm = document.getElementById('settingsModal');
    if (sm) { var op = modalOpener; closeSettings(); openSettings(op); }
    if (document.getElementById('leaveModal') && play) { closeLeaveConfirm(); confirmLeaveOnline(); }
    var nm = document.getElementById('noticeModal');
    if (nm && lastNotice) { nm.remove(); showNotice(lastNotice[0], lastNotice[1], lastNotice[2]); }
  });

  /* ---------- 啟動 ---------- */
  applySettings();
  renderBest();
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && play && play.mode === 'solo' && play.running && !play.over && !play.paused) pauseSolo(true);
  });

  /* 給測試用的掛勾（不影響遊戲） */
  window.__ph = { get play() { return play; }, go: go, startPlay: startPlay, get online() { return online; }, layout: layout };
})();
