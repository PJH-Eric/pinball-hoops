/* ===== audio.js — 全部用 Web Audio 即時合成的音效與背景音樂 =====
 * 沒有任何外部音檔，授權零負擔。要換成正式素材時，只要改 sfx() 與 BGM 區塊：
 * 對外介面（unlock / sfx / music / setMusic / setSfx）不會變。
 */
(function (root) {
  'use strict';

  var ctx = null, master = null, musicGain = null, sfxGain = null;
  var state = { musicOn: true, sfxOn: true, musicLevel: 3, sfxLevel: 4 };
  var bgmTimer = null, step = 0, wantMusic = false;
  var noiseBuf = null;

  function levelGain(l) { return l <= 0 ? 0 : Math.pow(l / 5, 1.6) * 0.9; }

  function applyGains() {
    if (!ctx) return;
    musicGain.gain.value = state.musicOn ? levelGain(state.musicLevel) * 0.32 : 0;
    sfxGain.gain.value = state.sfxOn ? levelGain(state.sfxLevel) : 0;
  }

  /** 第一次使用者手勢時呼叫，瀏覽器才允許出聲 */
  function unlock() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.8; master.connect(ctx.destination);
      musicGain = ctx.createGain(); musicGain.connect(master);
      sfxGain = ctx.createGain(); sfxGain.connect(master);
      var len = ctx.sampleRate * 0.5;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      applyGains();
      if (wantMusic) startBgm();
    } catch (e) { ctx = null; }
  }

  function tone(freq, dur, type, vol, when, bus, slideTo) {
    if (!ctx) return;
    var t = ctx.currentTime + (when || 0);
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus || sfxGain);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noise(dur, vol, hp, when, bus) {
    if (!ctx) return;
    var t = ctx.currentTime + (when || 0);
    var s = ctx.createBufferSource(); s.buffer = noiseBuf;
    var f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp || 2000;
    var g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(bus || sfxGain);
    s.start(t); s.stop(t + dur + 0.02);
  }

  function sfx(name, power) {
    if (!ctx || !state.sfxOn) return;
    var p = power == null ? 0.6 : power;
    switch (name) {
      case 'flip': tone(180, 0.06, 'square', 0.12, 0, null, 90); noise(0.03, 0.08, 3000); break;
      case 'flipHit': tone(120 + p * 80, 0.12, 'triangle', 0.4, 0, null, 60); break;
      case 'wall': tone(260, 0.05, 'triangle', 0.1 + p * 0.1, 0, null, 180); break;
      case 'bump': tone(520, 0.12, 'square', 0.22, 0, null, 880); tone(1040, 0.08, 'sine', 0.12, 0.02); break;
      case 'rim': tone(740, 0.2, 'triangle', 0.3, 0, null, 620); tone(1110, 0.14, 'sine', 0.12, 0.01); break;
      case 'pad': tone(150, 0.2, 'sine', 0.4, 0, null, 420); break;
      case 'swish': noise(0.28, 0.3, 4500); tone(988, 0.35, 'sine', 0.2, 0.02); tone(1318, 0.4, 'sine', 0.18, 0.1); tone(1760, 0.5, 'sine', 0.16, 0.2); break;
      case 'score': noise(0.12, 0.14, 3500); tone(659, 0.18, 'triangle', 0.3); tone(880, 0.26, 'triangle', 0.3, 0.1); break;
      case 'combo': tone(1047, 0.1, 'square', 0.12); tone(1319, 0.14, 'square', 0.12, 0.08); break;
      case 'drain': tone(330, 0.5, 'sawtooth', 0.2, 0, null, 70); break;
      case 'serve': tone(392, 0.08, 'sine', 0.18); break;
      case 'count': tone(660, 0.14, 'square', 0.2); break;
      case 'go': tone(990, 0.4, 'square', 0.24); tone(1480, 0.4, 'sine', 0.16, 0.02); break;
      case 'buzzer': tone(120, 0.9, 'sawtooth', 0.35); tone(126, 0.9, 'square', 0.18); break;
      case 'win': tone(523, 0.16, 'triangle', 0.3); tone(659, 0.16, 'triangle', 0.3, 0.14); tone(784, 0.16, 'triangle', 0.3, 0.28); tone(1047, 0.5, 'triangle', 0.32, 0.42); break;
      case 'ui': tone(700, 0.05, 'square', 0.1); break;
    }
  }

  /* ----- 背景音樂：街頭 beat（低音＋hi-hat＋簡單旋律），十六步循環 ----- */
  var BASS = [55, 0, 55, 0, 65.4, 0, 55, 0, 73.4, 0, 73.4, 0, 65.4, 0, 49, 0];
  var LEAD = [0, 0, 440, 0, 0, 523, 0, 440, 0, 0, 587, 0, 523, 0, 392, 0];

  function startBgm() {
    if (!ctx || bgmTimer) return;
    step = 0;
    bgmTimer = setInterval(function () {
      if (!state.musicOn || !ctx) return;
      var i = step % 16;
      if (i % 4 === 0) tone(60, 0.16, 'sine', 0.9, 0, musicGain, 38);
      if (i % 2 === 1) noise(0.04, 0.18, 7000, 0, musicGain);
      if (i === 4 || i === 12) noise(0.12, 0.28, 1800, 0, musicGain);
      if (BASS[i]) tone(BASS[i], 0.2, 'sawtooth', 0.28, 0, musicGain);
      if (LEAD[i]) tone(LEAD[i], 0.16, 'square', 0.1, 0, musicGain);
      step++;
    }, 150);
  }

  function stopBgm() {
    if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
  }

  function music(on) {
    wantMusic = !!on;
    if (on) startBgm(); else stopBgm();
  }

  function configure(s) {
    state.musicOn = s.musicOn !== false;
    state.sfxOn = s.sfxOn !== false;
    if (typeof s.musicLevel === 'number') state.musicLevel = s.musicLevel;
    if (typeof s.sfxLevel === 'number') state.sfxLevel = s.sfxLevel;
    applyGains();
  }

  root.GameAudio = { unlock: unlock, sfx: sfx, music: music, configure: configure, state: state };
})(typeof self !== 'undefined' ? self : this);
