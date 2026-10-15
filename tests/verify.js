/* ===== tests/verify.js — 規則核心、房間邏輯、設定解析的單元測試（零依賴）===== */
'use strict';
const assert = require('assert');
const Rules = require('../public/js/rules.js');
const { createHub, cleanName } = require('../lib/rooms.js');
const { play, botInput } = require('./bot.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

console.log('規則核心');
t('四段難度都存在且參數單調變難', () => {
  const L = Rules.DIFF_LIST.map(k => Rules.DIFFS[k]);
  assert.deepStrictEqual(Rules.DIFF_LIST, ['kids', 'easy', 'normal', 'hard']);
  for (let i = 1; i < L.length; i++) {
    assert(L[i].hoopW < L[i - 1].hoopW, '籃框要越來越小');
    assert(L[i].hoopFreq > L[i - 1].hoopFreq, '籃框要越來越快');
    assert(L[i].gravity > L[i - 1].gravity, '重力要越來越大');
  }
  assert.strictEqual(Rules.DIFFS.kids.drainOpen, false, '幼幼班不會漏球');
  assert(Rules.DIFFS.hard.bumpers > Rules.DIFFS.normal.bumpers);
});
t('同種子＋同操作 → 結果完全一致（可重現）', () => {
  const a = play('normal', 4242), b = play('normal', 4242);
  assert.strictEqual(a.score, b.score);
  assert.strictEqual(a.hoops, b.hoops);
  assert.strictEqual(a.bumps, b.bumps);
  assert.strictEqual(a.t, b.t);
});
t('不同種子會有不同發球', () => {
  const x = Rules.create('normal', 1).ball, y = Rules.create('normal', 2).ball;
  assert(x.x !== y.x || x.vx !== y.vx);
});
t('時間到會結束，且不超過難度時間', () => {
  const g = play('easy', 7);
  assert.strictEqual(g.status, 'over');
  assert(g.t <= Rules.DIFFS.easy.duration + 0.05);
});
t('球用完（球數制）會提早結束；幼幼班不會漏球', () => {
  const g = Rules.create('hard', 3);
  for (let i = 0; i < 200000 && g.status === 'playing'; i++) Rules.update(g, 1 / 60, { left: false, right: false });
  assert.strictEqual(g.status, 'over');
  assert.strictEqual(g.overReason, 'balls');
  assert.strictEqual(g.ballNo, 3);
  const k = Rules.create('kids', 3);
  let drains = 0;
  for (let i = 0; i < 60 * 60 && k.status === 'playing'; i++) { Rules.update(k, 1 / 60, {}); k.events.forEach(e => { if (e.type === 'drain') drains++; }); k.events.length = 0; }
  assert.strictEqual(drains, 0, '幼幼班彈力墊不該漏球');
});
t('機器人能得到分數（球真的可以進框）', () => {
  let hoops = 0;
  for (let s = 1; s <= 12; s++) hoops += play('easy', s * 31).hoops;
  assert(hoops > 0, '12 局都進不了球，物理或籃框有問題');
});
t('穿過籃框才算進球，從下往上不算', () => {
  const g = Rules.create('easy', 1);
  const hy = g.geo.hoop.y;
  g.ball.x = g.hoopX; g.ball.y = hy + 30; g.ball.vx = 0; g.ball.vy = -900;
  for (let i = 0; i < 40; i++) Rules.step(g, {});     /* 球已由下往上穿過框線、還在上升 */
  assert(g.ball.y < hy - 10, '測試前提：球要已經穿到框上方');
  assert.strictEqual(g.hoops, 0, '往上穿過不該得分');
  const h = Rules.create('easy', 1);
  h.ball.x = h.hoopX; h.ball.y = hy - 40; h.ball.vx = 0; h.ball.vy = 200;
  for (let i = 0; i < 240; i++) Rules.step(h, {});
  assert.strictEqual(h.hoops, 1, '由上往下穿過要得分');
  assert.strictEqual(h.swishes, 1, '沒碰框是空心球');
  assert.strictEqual(h.score - h.bumps, 30, '空心球 30 分（彈跳墊另外每下 1 分）');
});
t('連擊倍率：7 秒內連進，倍率遞增，最高 ×5', () => {
  const g = Rules.create('kids', 1);
  const hy = g.geo.hoop.y;
  const scores = [];
  for (let n = 0; n < 6; n++) {
    g.ball.x = g.hoopX; g.ball.y = hy - 30; g.ball.vx = 0; g.ball.vy = 200; g.ball.armed = true; g.ball.rim = false;
    const before = g.score;
    for (let i = 0; i < 120; i++) Rules.step(g, {});
    scores.push(g.score - before - 0);
  }
  assert(g.bestCombo === 5, '最高連擊應為 5，實際 ' + g.bestCombo);
  assert(g.combo <= 5);
});
t('超過連擊時間，倍率重算', () => {
  const g = Rules.create('kids', 1);
  const hy = g.geo.hoop.y;
  function shot() { g.ball.x = Rules.hoopXAt(g.geo, g.t + 0.02); g.ball.y = hy - 30; g.ball.vx = 0; g.ball.vy = 200; g.ball.armed = true; for (let i = 0; i < 120; i++) Rules.step(g, {}); }
  shot(); shot();
  assert.strictEqual(g.combo, 2);
  g.t += Rules.COMBO_WINDOW + 1;
  shot();
  assert.strictEqual(g.combo, 1);
});
t('只有一片彈板，點一下（flip）就揮起、放開就落下', () => {
  const g = Rules.create('normal', 1);
  assert.strictEqual(g.fl.length, 1);
  for (let i = 0; i < 240; i++) Rules.step(g, { flip: true });
  assert(Math.abs(g.fl[0].a - Rules.ACTIVE) < 1e-6, '應揮到最高');
  for (let i = 0; i < 240; i++) Rules.step(g, { flip: false });
  assert(Math.abs(g.fl[0].a - Rules.REST) < 1e-6, '應落回原位');
  const h = Rules.create('normal', 1);
  for (let i = 0; i < 240; i++) Rules.step(h, { left: true });     /* 相容舊的 left/right 輸入 */
  assert(h.fl[0].a < Rules.REST - 0.5);
});
t('彈板能把球往上打（不是穿過），打在中段力道夠到籃框高度', () => {
  const g = Rules.create('normal', 1);
  const b = g.ball; b.x = 340; b.y = 740; b.vx = 0; b.vy = 0;
  let minY = 1e9, t0 = null;
  for (let i = 0; i < 240 * 4 && g.ball; i++) {
    if (g.ball.y > 770 && t0 === null) t0 = g.t;
    Rules.step(g, { flip: t0 !== null && g.t - t0 >= 0.2 && g.t - t0 < 0.55 });
    g.events.length = 0;
    if (g.ball) minY = Math.min(minY, g.ball.y);
  }
  assert(minY < 300, '球應被打到半空以上，實際最高 y=' + minY);
});
t('時機對的話，彈板打出的球能進籃框', () => {
  let hoops = 0;
  for (const bx of [340, 380, 420]) for (const wait of [0.15, 0.3]) {
    const g = Rules.create('normal', 1);
    g.ball.x = bx; g.ball.y = 740; g.ball.vx = 0; g.ball.vy = 0;
    let t0 = null;
    for (let i = 0; i < 240 * 5 && g.ball; i++) {
      if (g.ball.y > 770 && t0 === null) t0 = g.t;
      Rules.step(g, { flip: t0 !== null && g.t - t0 >= wait && g.t - t0 < wait + 0.35 });
      g.events.length = 0;
    }
    hoops += g.hoops;
  }
  assert(hoops >= 2, '6 種時機至少要有 2 種進球，實際 ' + hoops);
});
t('球不會穿牆出界', () => {
  for (let s = 1; s <= 6; s++) {
    const g = Rules.create('hard', s);
    let escaped = false;
    for (let i = 0; i < 240 * 60 && g.status === 'playing'; i++) {
      Rules.step(g, botInput(g, 140));
      if (g.ball && (g.ball.x < -20 || g.ball.x > Rules.W + 20 || g.ball.y < -30)) escaped = true;
      g.events.length = 0;
    }
    assert(!escaped, '種子 ' + s + ' 球飛出界外');
  }
});
t('籃框位置落在牆內（最大偏移也不碰牆）', () => {
  Rules.DIFF_LIST.forEach(id => {
    const geo = Rules.geometry(id);
    const hw = geo.hoop.w / 2;
    assert(geo.hoop.cx - geo.hoop.amp - hw > 20, id + ' 左邊超出');
    assert(geo.hoop.cx + geo.hoop.amp + hw < Rules.W - 20, id + ' 右邊超出');
  });
});
t('彈板尖端與左牆之間的缺口比球大、且彈板越難越短', () => {
  let prev = 1e9;
  Rules.DIFF_LIST.forEach(id => {
    const geo = Rules.geometry(id);
    const tip = Rules.flipperTip(geo, 0, Rules.REST);
    assert(tip.x - Rules.FLIP_R > Rules.BALL_R * 2 + 4, id + ' 缺口太窄');
    assert(geo.flipLen < prev, id + ' 彈板要比前一級短'); prev = geo.flipLen;
  });
});

console.log('房間邏輯');
function person(id, name) { return { id, name, roomId: null, role: null }; }
function mkHub() { let now = 1000000; const hub = createHub({ now: () => now }); hub.advance = ms => { now += ms; }; return hub; }

t('暱稱消毒：去角括號／控制字元、限 12 字、空白給隨機名', () => {
  assert.strictEqual(cleanName('<b>阿明</b>'), 'b阿明/b');
  assert.strictEqual(cleanName('x'.repeat(40)).length, 12);
  assert(cleanName('   ').length > 0);
  assert(!/[<>]/.test(cleanName('<script>')));
});
t('建立房間、加入、座位上限 4，其餘轉觀戰', () => {
  const hub = mkHub();
  const h = person('h', '房主');
  const r = hub.createRoom(h, { difficulty: 'easy' }).room;
  const ps = [1, 2, 3].map(i => person('p' + i, 'P' + i));
  ps.forEach(p => assert.strictEqual(hub.join(p, r.id, {}).role, 'player'));
  const extra = person('x', 'X');
  const j = hub.join(extra, r.id, {});
  assert.strictEqual(j.role, 'spec');
  assert.strictEqual(j.notice, 'seats_full');
});
t('邀請：以 token 決定角色，改暱稱不改權限；無效／撤銷／過期有不同代碼', () => {
  const hub = mkHub();
  const h = person('h', 'H');
  const room = hub.createRoom(h, { listed: false }).room;
  const view = hub.viewFor(room, 'h');
  assert(view.invite.play && view.invite.watch);
  assert.strictEqual(hub.join(person('a', 'A'), room.id, {}).code, 'invite_required', '不公開房間需要邀請');
  const w = hub.join(person('w', '想當玩家的人'), room.id, { token: view.invite.watch, want: 'play' });
  assert.strictEqual(w.role, 'spec', '觀戰邀請不能自己改成玩家');
  const p = hub.join(person('p', 'P'), room.id, { token: view.invite.play, want: 'watch' });
  assert.strictEqual(p.role, 'player');
  assert.strictEqual(hub.join(person('z', 'Z'), room.id, { token: 'bad' }).code, 'invite_invalid');
  hub.regenInvite(h);
  assert.strictEqual(hub.join(person('y', 'Y'), room.id, { token: view.invite.play }).code, 'invite_revoked');
  const fresh = hub.viewFor(room, 'h').invite;
  hub.advance(7 * 3600 * 1000);
  assert.strictEqual(hub.join(person('e', 'E'), room.id, { token: fresh.play }).code, 'invite_expired');
});
t('開局條件：至少 2 人、全部準備；開局後新人只能觀戰', () => {
  const hub = mkHub();
  const h = person('h', 'H'), a = person('a', 'A');
  const room = hub.createRoom(h, {}).room;
  assert.strictEqual(hub.start(h).code, 'need_two');
  hub.join(a, room.id, {});
  assert.strictEqual(hub.start(h).code, 'not_ready');
  hub.setReady(a, true);
  assert(hub.start(h).ok);
  assert.strictEqual(hub.start(a).ok, false, '非房主不能開局');
  const late = hub.join(person('l', 'L'), room.id, {});
  assert.strictEqual(late.role, 'spec');
  assert.strictEqual(late.notice, 'match_running');
});
t('分數回報：單調遞增、超過物理速度的值會被丟掉', () => {
  const hub = mkHub();
  const h = person('h', 'H'), a = person('a', 'A');
  const room = hub.createRoom(h, { difficulty: 'normal' }).room;
  hub.join(a, room.id, {}); hub.setReady(a, true); hub.start(h);
  hub.advance(4000 + 10000);
  hub.report(a, { score: 50, hoops: 2 });
  assert.strictEqual(room.members.get('a').score, 50);
  hub.report(a, { score: 20 });
  assert.strictEqual(room.members.get('a').score, 50, '分數不能倒退');
  hub.report(a, { score: 999999 });
  assert.strictEqual(room.members.get('a').score, 50, '不可能的分數要丟掉');
});
t('全部完成或時間到 → 結束並排名（同分同名次）', () => {
  const hub = mkHub();
  const h = person('h', 'H'), a = person('a', 'A');
  const room = hub.createRoom(h, { difficulty: 'normal' }).room;
  hub.join(a, room.id, {}); hub.setReady(a, true); hub.start(h);
  hub.advance(4000 + 30000);
  hub.report(h, { score: 100, done: true });
  hub.report(a, { score: 100, hoops: 1, done: true });
  assert.strictEqual(room.phase, 'ended');
  assert.strictEqual(room.result[0].place, 1);
  assert.strictEqual(room.result[1].place, room.result[0].place === 1 && room.result[1].score === room.result[0].score ? 1 : 2);
  hub.again(h);
  assert.strictEqual(room.phase, 'lobby');
  assert.strictEqual(room.members.get('a').ready, false);
});
t('時間到＋寬限後即使有人沒回報也會結束', () => {
  const hub = mkHub();
  const h = person('h', 'H'), a = person('a', 'A');
  const room = hub.createRoom(h, { difficulty: 'normal' }).room;
  hub.join(a, room.id, {}); hub.setReady(a, true); hub.start(h);
  hub.advance(4000 + 90000 + 3600);
  hub.tick();
  assert.strictEqual(room.phase, 'ended');
});
t('零實體玩家 → 立即關房：邀請失效、從大廳移除、通知觀戰者', () => {
  const hub = mkHub();
  const h = person('h', 'H'), s = person('s', '觀戰者');
  const room = hub.createRoom(h, {}).room;
  const inv = hub.viewFor(room, 'h').invite;
  hub.join(s, room.id, { token: inv.watch });
  hub.drain();
  hub.leave(h);
  assert(!hub.rooms.has(room.id), '房間應已移除');
  assert.strictEqual(hub.listRooms().length, 0);
  const ev = hub.drain();
  const closed = ev.find(e => e.kind === 'closed');
  assert(closed && closed.memberIds.includes('s'), '要通知還在房內的觀戰者');
  assert.strictEqual(hub.join(person('n', 'N'), room.id, { token: inv.play }).code, 'room_closed', '已關房間的邀請失效');
  assert.strictEqual(hub.resume(h, room.id).code, 'room_closed', '重新連線不能讓房間復活');
});
t('斷線也算：最後一位真人斷線 → 關房（觀戰者不算）', () => {
  const hub = mkHub();
  const h = person('h', 'H'), a = person('a', 'A'), s = person('s', 'S');
  const room = hub.createRoom(h, {}).room;
  hub.join(a, room.id, {}); hub.join(s, room.id, { want: 'watch' });
  hub.markDisconnected(h);
  assert(hub.rooms.has(room.id), '還有一位真人，房間要保留');
  assert.strictEqual(hub.viewFor(room, 'a').hostId, 'a', '房主斷線要換人');
  hub.markDisconnected(a);
  assert(!hub.rooms.has(room.id), '只剩觀戰者，房間要關閉');
});
t('對局中斷線保留分數，原連線可重連；全部斷線仍會關房', () => {
  const hub = mkHub();
  const h = person('h', 'H'), a = person('a', 'A');
  const room = hub.createRoom(h, { difficulty: 'normal' }).room;
  hub.join(a, room.id, {}); hub.setReady(a, true); hub.start(h);
  hub.advance(8000);
  hub.report(a, { score: 40 });
  hub.markDisconnected(a);
  assert.strictEqual(room.members.get('a').score, 40);
  assert(hub.resume(a, room.id).ok, '對局中可重連');
  assert.strictEqual(room.members.get('a').connected, true);
  hub.markDisconnected(a); hub.markDisconnected(h);
  assert(!hub.rooms.has(room.id));
});
t('聊天：消毒、限長、限速', () => {
  const hub = mkHub();
  const h = person('h', 'H');
  hub.createRoom(h, {});
  const m = hub.chat(h, '<img src=x>' + 'a'.repeat(200));
  assert(!/[<>]/.test(m.msg.text)); assert(m.msg.text.length <= 80);
  let ok = 0;
  for (let i = 0; i < 12; i++) if (hub.chat(h, 'hi')) ok++;
  assert(ok <= 5, '5 秒內最多 5 句');
});
t('房主可請出玩家；非房主不行', () => {
  const hub = mkHub();
  const h = person('h', 'H'), a = person('a', 'A');
  const room = hub.createRoom(h, {}).room;
  hub.join(a, room.id, {});
  assert.strictEqual(hub.kick(a, 'h'), null);
  assert.strictEqual(hub.kick(h, 'a'), 'a');
  assert(!room.members.has('a'));
});

console.log('設定解析');
t('server URL：query／同源／無效／https 擋 http', () => {
  global.self = undefined;
  const src = require('fs').readFileSync(require('path').join(__dirname, '../public/js/config.js'), 'utf8');
  const root = {};
  new Function('self', src).call(root, root);
  const R = root.Config.resolve;
  assert.strictEqual(R('', '', 'http:', 'http://localhost:3200').source, 'same-origin');
  assert.strictEqual(R('https://a.onrender.com/', '', 'https:', 'https://x.github.io').url, 'https://a.onrender.com');
  assert.strictEqual(R('', 'https://b.com', 'https:', 'https://x.github.io').source, 'query');
  assert.strictEqual(R('ftp://x', '', 'https:', 'https://x').status, 'invalid');
  assert.strictEqual(R('http://a.com', '', 'https:', 'https://x').status, 'invalid');
  assert.strictEqual(R('', '', 'file:', 'null').status, 'unset');
});

console.log('\n' + passed + ' 項通過' + (process.exitCode ? '（有失敗）' : ''));
