/* 測試用的簡單機器人：球滾到彈板上、靠近樞軸時揮板。只拿來驗證「規則核心真的能得分」。 */
'use strict';
const Rules = require('../public/js/rules.js');

function botInput(g, reach) {
  const b = g.ball;
  const inp = { flip: false };
  if (!b) return inp;
  const p = g.geo.pivots[0];
  const dx = p.x - b.x;                         /* 球離樞軸多遠（往左為正） */
  const near = dx > -10 && dx < (reach == null ? 120 : reach) && b.y > 700 && b.y < 830 && b.vy > -50;
  const slow = Math.abs(b.vx) + Math.abs(b.vy) < 60;
  if (near && !slow) inp.flip = true;
  if (!slow && g.fl[0].a < Rules.REST - 0.05 && b.y > 690 && b.y < 850 && dx > 0) inp.flip = true;   /* 揮到一半不收 */
  return inp;
}

function play(diff, seed, reach) {
  const g = Rules.create(diff, seed);
  let guard = 0;
  while (g.status === 'playing' && guard++ < 200000) {
    Rules.update(g, 1 / 60, botInput(g, reach));
    g.events.length = 0;
  }
  return g;
}

module.exports = { botInput, play };
