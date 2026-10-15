/* ===== lib/cpu.js — 電腦玩家：在伺服器上跑同一套規則核心，用簡單的規則型機器人「真的」打一局 =====
 *
 * 不是亂編分數：電腦和真人用同一張台（同難度、同種子），球怎麼彈、籃框怎麼動都一樣，
 * 它只是用固定的反應規則決定「什麼時候揮板」。強弱靠「反應範圍」與「恍神機率」調整。
 */
'use strict';
const Rules = require('../public/js/rules.js');
const Rng = require('../public/js/rng.js');

const SKILLS = {
  easy:   { id: 'easy',   name: '新手', reach: 120, lapse: 0.4 },
  normal: { id: 'normal', name: '一般', reach: 160, lapse: 0.2 },
  hard:   { id: 'hard',   name: '高手', reach: 190, lapse: 0.03 }
};
const SKILL_LIST = ['easy', 'normal', 'hard'];

function create(diffId, seed, skillId, salt) {
  const sk = SKILLS[skillId] || SKILLS.normal;
  const g = Rules.create(diffId, seed);
  const rnd = Rng.mulberry32 ? Rng.mulberry32((seed ^ (salt || 0x9e3779b9)) >>> 0) : Math.random;
  let alert = true, nextLook = 0;

  function input() {
    const b = g.ball, inp = { flip: false };
    if (!b) return inp;
    if (g.t >= nextLook) { alert = rnd() >= sk.lapse; nextLook = g.t + 0.25; }
    const p = g.geo.pivots[0];
    const dx = p.x - b.x;
    const near = dx > -10 && dx < sk.reach && b.y > 700 && b.y < 830 && b.vy > -50;
    const slow = Math.abs(b.vx) + Math.abs(b.vy) < 60;
    const midSwing = g.fl[0].a < Rules.REST - 0.05 && b.y > 690 && b.y < 850 && dx > 0;
    if (!slow && (midSwing || (alert && near))) inp.flip = true;
    return inp;
  }

  /** 推進到比賽時間 tSec（秒）。回傳是否已結束。 */
  function advanceTo(tSec) {
    let guard = 0;
    while (g.status === 'playing' && g.t < tSec && guard++ < 100000) {
      Rules.update(g, 1 / 60, input());
      g.events.length = 0;
    }
    return g.status !== 'playing';
  }
  return { g, advanceTo, skill: sk };
}

module.exports = { SKILLS, SKILL_LIST, create };
