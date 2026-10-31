/* ===== app.js — 單機遊戲畫面、遊戲迴圈與設定視窗 ===== */
(function () {
  'use strict';

  var Rules = window.Rules, Store = window.Store, Audio = window.GameAudio;
  var Render = window.Render;
  var I18N = window.I18N;
  function T(k, p) { return I18N.t(k, p); }

  function dn(id) { return T('diff.' + id + '.name'); }

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

  function go(name) {
    screen = name;
    app.dataset.screen = name;
    if (name !== 'play') { stopLoop(); }
    if (name === 'home') renderBest();
    if (name === 'solo') renderSoloDiffs();
    if (name === 'play') { startLoop(); requestAnimationFrame(layout); }
    sfx('ui');
  }

  $$('[data-go]').forEach(function (b) {
    b.addEventListener('click', function () {
      var to = b.getAttribute('data-go');
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
    var wasRunning = play && play.running && !play.paused && !play.over;
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
      if (play && play.running && !play.over) { pauseSolo(!play.paused); e.preventDefault(); }
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

  /* 整個遊戲畫面都是「揮板鍵」：按鈕、面板與對話框除外 */
  var stageEl = $('#stage');
  function isUi(t) { return t.closest && t.closest('button, a, input, #overlay, #panel, #hud'); }
  stageEl.addEventListener('pointerdown', function (e) {
    if (isUi(e.target)) return;
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
    GameAnalytics.start({ mode: 'solo', difficulty: o.diff, players: 1 });
    closeOverlay();
    rend.reset();
    play = {
      mode: 'solo', diff: o.diff, seed: o.seed,
      g: Rules.create(o.diff, o.seed), cd: 3, running: false, paused: false, over: false,
      resultShown: false, newBest: false
    };
    pauseLabel();
    go('play');
    applyPanelMode(true);
    updateHud(true);
    updateSummary();
  }

  function pauseLabel() {
    if (!play) return;
    $('#btnPause').textContent = T('play.pause');
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    var dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    if (screen !== 'play' || !play) return;
    var p = play, inp = currentInput(), opts;
    opts = { reduceMotion: !!Store.get('reduceMotion'), contrast: !!Store.get('contrast'), pressed: [inp.flip] };

    var g = p.g;
    if (!p.running) {
      if (!p.paused) p.cd -= dt;
      var n = Math.ceil(p.cd);
      if (p.cd > 0) showCount(n); else startRunning();
    } else if (!p.paused && !p.over) {
      Rules.update(g, dt, inp);
      handleEvents(g);
      if (g.status === 'over' && !p.over) onLocalOver();
    }

    opts.bumperFlash = g.bumperFlash;
    opts.timingHint = !!Store.get('timingHint');
    rend.draw(Rules.view(g), opts);
    updateHud();
  }

  function idleView() {
    var geo = Rules.geometry(play.diff);
    return { diff: play.diff, ball: null, fl: [Rules.REST], hx: geo.hoop.x, hy: geo.hoop.cy, score: 0, combo: 0, ballNo: 0, t: 0 };
  }

  var lastCount = 0;
  function showCount(n) {
    if (play.paused) return;
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
    rend.pop(300, 420, T('pop.start'), '#ffe14d');
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
          break;
        case 'score':
          sfx(e.swish ? 'swish' : 'score');
          if (e.combo > 1) sfx('combo');
          rend.flash(); rend.shake(8);
          rend.spark(g.hoopX, g.hoopY + 10, '#ffe14d', 22);
          rend.pop(Math.min(g.hoopX, 470), g.hoopY + 56, '+' + e.points + (e.swish ? T('pop.swish') : ''), e.swish ? '#22e4ff' : '#ffe14d');
          vibrate(e.swish ? [30, 40, 30] : 30);
          break;
        case 'drain':
          sfx('drain'); vibrate(80);
          rend.pop(300, 800, !g.unlimited && g.diff.balls > 0 && g.ballNo >= g.diff.balls ? T('pop.ballsOut') : T('pop.drain'), '#ff3d9a');
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
    p.newBest = Store.recordBest(g.diff.id, g.score);
    Store.recordGame(Rules.summary(g));
    setTimeout(function () { if (play === p) { sfx(p.newBest ? 'win' : 'ui'); } }, 600);
    setTimeout(function () { if (play === p) showResult(); }, 900);
  }

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
    var g = p.g, left = Rules.timeLeft(g), total = g.diff.duration;
    var combo = g.t - g.lastScoreT > Rules.COMBO_WINDOW ? 0 : g.combo;
    var balls = g.unlimited ? 0 : g.diff.balls;
    setText('hScore', String(g.score));
    setText('hTime', String(Math.ceil(left)));
    $('#hBar').style.transform = 'scaleX(' + (Math.max(0, left) / total).toFixed(3) + ')';
    var ballsEl = $('#hBalls');
    var key = balls === 0 ? 'inf' : balls + ':' + g.ballNo;
    if (hudCache.balls !== key) {
      hudCache.balls = key;
      ballsEl.textContent = '';
      if (balls === 0) ballsEl.appendChild(h('b', { text: '∞' }));
      else for (var i = 0; i < balls; i++) ballsEl.appendChild(h('i', { class: 'ball-ico' + (i < g.ballNo - 1 || (!g.ball && i < g.ballNo) ? ' used' : '') }));
    }
    var ce = $('#hCombo');
    ce.hidden = combo < 1;
    if (combo >= 1) setText('hComboN', String(combo));
    $('#hComboTime').hidden = !combo;
    if (combo) setText('hComboTime', Math.max(0, Rules.COMBO_WINDOW - (g.t - g.lastScoreT)).toFixed(1) + 's');
    $('#hBonus').hidden = !Rules.bonusActive(g.t);
    var summaryKey = g.hoops + ':' + g.swishes + ':' + g.bumps + ':' + g.bestCombo;
    if (hudCache.sum !== summaryKey) { hudCache.sum = summaryKey; updateSummary(); }
  }

  function updateSummary() {
    var box = $('#sumBox');
    if (!play) return;
    box.textContent = '';
    box.className = 'sum';
    var g = play.g, best = (Store.get('best') || {})[g.diff.id] || 0;
    box.appendChild(h('h4', { text: T('sum.solo', { diff: dn(g.diff.id) }) }));
    [[T('sum.best'), best], [T('sum.hoops'), g.hoops], [T('sum.swishes'), g.swishes], [T('sum.bestCombo'), '×' + g.bestCombo], [T('sum.bumps'), g.bumps]].forEach(function (r) {
      box.appendChild(h('div', { class: 'kv' }, h('span', { text: r[0] }), h('b', { text: String(r[1]) })));
    });
    box.appendChild(h('p', { class: 'muted', text: T('sum.hint') }));
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
    setTimeout(layout, 30);
  }
  if (wideMq.addEventListener) wideMq.addEventListener('change', function () { applyPanelMode(true); });
  $('#panelToggle').addEventListener('click', function () { panelOpen = !panelOpen; applyPanelMode(); sfx('ui'); });
  $('#panelClose').addEventListener('click', function () { panelOpen = false; applyPanelMode(); sfx('ui'); });
  $('#btnPause').addEventListener('click', function () {
    if (play && play.running && !play.over) pauseSolo(!play.paused);
  });

  /* ---------- 暫停、結算 ---------- */
  function closeOverlay() { var ov = $('#overlay'); ov.hidden = true; ov.textContent = ''; ov.style.background = ''; lastCount = 0; }

  function pauseSolo(on) {
    if (!play) return;
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
    play = null;
    closeOverlay();
    go(to);
  }

  function showResult() {
    if (play) GameAnalytics.end({ result: 'complete' });
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
    btns.appendChild(dlgBtn(T('res.home'), 'ghost', function () { leavePlay('home'); }));
    dlg.appendChild(btns);
    ov.appendChild(dlg);
    var f = $('.dialog button:not([aria-disabled])', ov); if (f && document.activeElement && document.activeElement.tagName !== 'INPUT') f.focus();
  }

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
    pauseLabel();
    if (play) {
      updateSummary();
      var ovDlg = $('#overlay .dialog');
      if (ovDlg) { if (play.resultShown) renderResult(); else if (play.paused) { renderPause(); var pf = $('#overlay .dialog button'); if (pf) pf.focus(); } }
    }
    rend.bg = null;
    var sm = document.getElementById('settingsModal');
    if (sm) { var op = modalOpener; closeSettings(); openSettings(op); }
  });

  /* ---------- 啟動 ---------- */
  applySettings();
  renderBest();
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && play && play.running && !play.over && !play.paused) pauseSolo(true);
  });

  /* 給測試用的掛勾（不影響遊戲） */
  window.__ph = { get play() { return play; }, go: go, startPlay: startPlay, layout: layout };
})();
