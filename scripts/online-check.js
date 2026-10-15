/* ===== scripts/online-check.js — 真的起一個伺服器，用 3 條 WebSocket 走完整個線上流程 =====
 * 需要 Node 22+（內建 WebSocket 客戶端）。用法：node scripts/online-check.js
 */
'use strict';
const assert = require('assert');
const { server } = require('../server.js');

if (typeof WebSocket === 'undefined') { console.log('略過：這個 Node 版本沒有內建 WebSocket（需要 22 以上）'); process.exit(0); }

function client(base, name) {
  const c = { name, msgs: [], waiters: [] };
  c.ws = new WebSocket(base.replace('http', 'ws') + '/ws?key=' + name + Math.random().toString(36).slice(2));
  c.ready = new Promise(res => { c.ws.onopen = res; });
  c.ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    c.msgs.push(m);
    c.waiters = c.waiters.filter(w => { if (w.test(m)) { w.res(m); return false; } return true; });
  };
  c.send = o => c.ws.send(JSON.stringify(o));
  c.wait = (test, ms) => new Promise((res, rej) => {
    const hit = c.msgs.find(test);
    if (hit) return res(hit);
    const to = setTimeout(() => rej(new Error(name + ' 等不到訊息：' + test)), ms || 4000);
    c.waiters.push({ test, res: m => { clearTimeout(to); res(m); } });
  });
  c.last = type => c.msgs.filter(m => m.type === type).pop();
  c.clear = () => { c.msgs.length = 0; };
  return c;
}

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

server.listen(0, async () => {
  const port = server.address().port;
  const base = 'http://localhost:' + port;
  console.log('線上流程（port ' + port + '）');

  const host = client(base, 'host'), guest = client(base, 'guest'), spec = client(base, 'spec'), late = client(base, 'late');
  await Promise.all([host.ready, guest.ready, spec.ready, late.ready]);
  let roomId, inv;

  await t('/health 與 /api/rooms', async () => {
    const h = await (await fetch(base + '/health')).json();
    assert.strictEqual(h.ok, true); assert.strictEqual(h.game, 'pinball-hoops');
    const r = await (await fetch(base + '/api/rooms')).json();
    assert.deepStrictEqual(r.rooms, []);
  });

  await t('房主建立房間，大廳列表更新', async () => {
    guest.send({ type: 'hello', name: '客人' });
    await guest.wait(m => m.type === 'lobby');
    host.send({ type: 'create', name: '<b>房主</b>', difficulty: 'hard', listed: true });
    const j = await host.wait(m => m.type === 'joined');
    roomId = j.roomId;
    assert.strictEqual(j.role, 'player');
    const room = (await host.wait(m => m.type === 'room')).room;
    assert(!/[<>]/.test(room.players[0].name), '暱稱要消毒');
    inv = room.invite;
    assert(inv.play && inv.watch);
    const lobby = await guest.wait(m => m.type === 'lobby' && m.rooms.length === 1);
    assert.strictEqual(lobby.rooms[0].id, roomId);
    assert.strictEqual(lobby.rooms[0].difficultyName, '困難');
  });

  await t('非房主看不到邀請 token', async () => {
    guest.clear();
    guest.send({ type: 'join', roomId, name: '客人', want: 'play' });
    await guest.wait(m => m.type === 'joined');
    const room = (await guest.wait(m => m.type === 'room')).room;
    assert.strictEqual(room.you.role, 'player');
    assert.strictEqual(room.invite, undefined);
  });

  await t('觀戰邀請：用 token 加入為觀戰者，聊天室可用', async () => {
    spec.send({ type: 'join', roomId, name: '觀眾', token: inv.watch, want: 'play' });
    const j = await spec.wait(m => m.type === 'joined');
    assert.strictEqual(j.role, 'spec', '觀戰 token 不能自己改成玩家');
    spec.send({ type: 'chat', text: '大家加油' });
    const c = await host.wait(m => m.type === 'chat' && m.msg.text === '大家加油');
    assert.strictEqual(c.msg.role, 'spec');
  });

  await t('開局前：沒準備不能開，準備後可開', async () => {
    host.clear();
    host.send({ type: 'start' });
    const e = await host.wait(m => m.type === 'error');
    assert.strictEqual(e.code, 'not_ready');
    guest.send({ type: 'ready', on: true });
    host.clear();
    host.send({ type: 'start' });
    const room = (await host.wait(m => m.type === 'room' && m.room.phase === 'playing')).room;
    assert(room.seed > 0); assert(room.startAt > room.serverNow);
  });

  await t('比賽中：新人只能觀戰；觀戰者收到即時畫面', async () => {
    late.send({ type: 'join', roomId, name: '遲到', want: 'play' });
    const j = await late.wait(m => m.type === 'joined');
    assert.strictEqual(j.role, 'spec'); assert.strictEqual(j.notice, 'match_running');
    await new Promise(r => setTimeout(r, 4700));
    host.send({ type: 'snap', b: [100, 200, 0.5], f: [0.5, 0.5], h: 300 });
    host.send({ type: 'score', score: 41, hoops: 1, combo: 1, ballNo: 1 });
    const s = await spec.wait(m => m.type === 'snaps' && m.s && Object.keys(m.s).length > 0, 3000);
    assert.deepStrictEqual(Object.values(s.s)[0].b.slice(0, 2), [100, 200]);
  });

  await t('分數即時廣播；超過物理上限的分數被丟掉', async () => {
    host.send({ type: 'score', score: 999999, hoops: 99, combo: 5, ballNo: 1 });
    guest.send({ type: 'score', score: 25, hoops: 1, combo: 1, ballNo: 1 });
    const r = await spec.wait(m => m.type === 'room' && m.room.players.some(p => p.score === 25));
    const hp = r.room.players.find(p => p.isHost);
    assert(hp.score <= 41 + 1, '作弊分數不該被收下，實際 ' + hp.score);
  });

  await t('全部回報完成 → 結束並排名', async () => {
    host.send({ type: 'score', score: 41, hoops: 1, combo: 1, ballNo: 3, done: true });
    guest.send({ type: 'score', score: 25, hoops: 1, combo: 1, ballNo: 3, done: true });
    const r = await spec.wait(m => m.type === 'room' && m.room.phase === 'ended');
    assert.strictEqual(r.room.result[0].score, 41);
    assert.strictEqual(r.room.result[0].place, 1);
    assert.strictEqual(r.room.result[1].place, 2);
  });

  await t('再來一局：回到等待狀態', async () => {
    guest.send({ type: 'again' });
    const r = await host.wait(m => m.type === 'room' && m.room.phase === 'lobby');
    assert.strictEqual(r.room.players.find(p => !p.isHost).ready, true);
  });

  await t('房主撤銷邀請 → 舊連結顯示「已撤銷」', async () => {
    host.send({ type: 'invite_regen' });
    await host.wait(m => m.type === 'room' && m.room.invite && m.room.invite.play !== inv.play);
    const x = client(base, 'x');
    await x.ready;
    x.send({ type: 'join', roomId, name: 'X', token: inv.play });
    const e = await x.wait(m => m.type === 'error');
    assert.strictEqual(e.code, 'invite_revoked');
    x.ws.close();
  });

  await t('房主離開、客人是唯一真人 → 房主換人；客人再離開 → 關房並通知觀戰者', async () => {
    host.send({ type: 'leave' });
    const r = await guest.wait(m => m.type === 'room' && m.room.hostId === m.room.you.id);
    assert(r);
    guest.clear(); spec.clear();
    guest.send({ type: 'leave' });
    const closed = await spec.wait(m => m.type === 'closed');
    assert.strictEqual(closed.roomId, roomId);
    const list = await (await fetch(base + '/api/rooms')).json();
    assert.deepStrictEqual(list.rooms, []);
  });

  await t('已關閉的房間：舊邀請與重連都無法復活它', async () => {
    const x = client(base, 'y');
    await x.ready;
    x.send({ type: 'join', roomId, name: 'Y', token: inv.watch });
    const e = await x.wait(m => m.type === 'error');
    assert.strictEqual(e.code, 'room_closed');
    x.send({ type: 'resume', roomId });
    await x.wait(m => m.type === 'closed');
    x.ws.close();
  });

  await t('斷線的最後一位真人 → 關房', async () => {
    const a = client(base, 'a'), s = client(base, 's');
    await Promise.all([a.ready, s.ready]);
    a.send({ type: 'create', name: 'A', difficulty: 'easy' });
    const j = await a.wait(m => m.type === 'joined');
    const iv = (await a.wait(m => m.type === 'room')).room.invite;
    s.send({ type: 'join', roomId: j.roomId, name: 'S', token: iv.watch });
    await s.wait(m => m.type === 'joined');
    a.ws.close();
    await s.wait(m => m.type === 'closed');
    s.ws.close();
  });

  console.log('\n' + passed + ' 項通過' + (process.exitCode ? '（有失敗）' : ''));
  [host, guest, spec, late].forEach(c => { try { c.ws.close(); } catch (e) { /* 忽略 */ } });
  setTimeout(() => process.exit(process.exitCode || 0), 100);
});
