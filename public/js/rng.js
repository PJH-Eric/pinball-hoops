/* ===== rng.js — 可注入種子的亂數（mulberry32）=====
 * 所有隨機都走這裡，讓相同種子與操作可以重現。
 */
(function (root) {
  'use strict';

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 由 (seed, index) 決定的單次亂數：每次發球獨立，不受前面操作影響 */
  function at(seed, index) {
    return mulberry32((Math.imul(seed >>> 0, 2654435761) + Math.imul(index + 1, 40503)) >>> 0)();
  }

  var api = { mulberry32: mulberry32, at: at };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Rng = api;
})(typeof self !== 'undefined' ? self : this);
