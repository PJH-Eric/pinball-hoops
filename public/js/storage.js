/* ===== storage.js — 設定、暱稱與本機最高分（localStorage 可能不可用，全部包 try/catch）===== */
(function (root) {
  'use strict';

  var KEY = 'pinball-hoops:v1';

  var DEFAULTS = {
    musicOn: true, sfxOn: true, musicLevel: 3, sfxLevel: 4,
    vibrate: true, reduceMotion: false, contrast: false,
    showHints: true,        /* 顯示鍵帽提示 */
    nick: '',
    best: {}                /* { 難度: 最高分 } */
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var data = clone(DEFAULTS);
  try {
    var raw = root.localStorage && root.localStorage.getItem(KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      Object.keys(DEFAULTS).forEach(function (k) {
        if (parsed && typeof parsed[k] === typeof DEFAULTS[k]) data[k] = parsed[k];
      });
    }
  } catch (e) { /* 沒有儲存也能玩 */ }

  function save() {
    try { root.localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 忽略 */ }
  }

  function set(key, value) { data[key] = value; save(); }

  function reset() {
    var keep = { nick: data.nick, best: data.best };
    data = clone(DEFAULTS);
    data.nick = keep.nick; data.best = keep.best;
    save();
  }

  /** 回傳是否破紀錄 */
  function recordBest(diff, score) {
    var old = data.best[diff] || 0;
    if (score > old) { data.best[diff] = score; save(); return true; }
    return false;
  }

  root.Store = {
    get: function (k) { return data[k]; },
    all: function () { return data; },
    set: set, reset: reset, recordBest: recordBest, DEFAULTS: DEFAULTS
  };
})(typeof self !== 'undefined' ? self : this);
