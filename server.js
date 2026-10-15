/* ===== server.js — 靜態檔案 ＋ 房間伺服器（零依賴）=====
 *
 * 靜態檔案用 Node 內建 http，連線用自己寫的 lib/ws.js（原生 WebSocket），
 * 整個專案不需要 npm install。
 *
 * 分工：
 *   lib/rooms.js  房間、席位、觀戰、邀請、計時、聊天（純邏輯）
 *   這一支         HTTP、WebSocket、身分（誰是誰）與訊息分派
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ws = require('./lib/ws.js');
const Rules = require('./public/js/rules.js');
const { createHub, CONST } = require('./lib/rooms.js');

const PORT = Number(process.env.PORT) || 3200;
const ROOT = path.join(__dirname, 'public');
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const GAME_ID = 'pinball-hoops';
const RESUME_MS = 30000;          /* 對局中斷線後，這段時間內可用同一把 key 回來 */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'
};

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('找不到這個檔案'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/* ---------- 連線名冊 ---------- */

const people = new Map();          /* personId → { socket, person } */
const byKey = new Map();           /* 重連用的 key → person（對局中斷線才會留） */
const hub = createHub();

function send(personId, msg) {
  const it = people.get(personId);
  if (it && it.socket.alive) it.socket.sendJSON(msg);
}

function errorTo(personId, code, text) { send(personId, { type: 'error', code, text }); }

const ERR = {
  room_closed: '這個房間已經結束了',
  invite_invalid: '邀請連結無效',
  invite_revoked: '這個邀請已被房主撤銷',
  invite_expired: '這個邀請已過期',
  invite_required: '這個房間不公開，需要邀請連結',
  spec_full: '觀戰席已滿',
  bad_phase: '現在不能這樣做',
  need_two: '至少要 2 位玩家才能開局',
  not_ready: '還有玩家沒有準備好',
  seats_full: '座位已滿',
  not_member: '你已經不在這個房間了'
};

/* ---------- 把 hub 累積的變化送出去 ---------- */

function sendRoom(room) {
  for (const id of hub.members(room)) {
    send(id, { type: 'room', room: hub.viewFor(room, id) });
  }
}

let lobbyDirty = false;
function sendLobby() {
  lobbyDirty = false;
  const list = hub.listRooms();
  for (const [id, it] of people) {
    if (!it.person.roomId) send(id, { type: 'lobby', rooms: list });
  }
}

function flush() {
  for (const ev of hub.drain()) {
    if (ev.kind === 'room') {
      const room = hub.rooms.get(ev.roomId);
      if (room) sendRoom(room);
    } else if (ev.kind === 'lobby') {
      lobbyDirty = true;
    } else if (ev.kind === 'closed') {
      for (const id of ev.memberIds) {
        const it = people.get(id);
        if (it) { it.person.roomId = null; it.person.role = null; }
        send(id, { type: 'closed', roomId: ev.roomId, reason: ev.reason });
      }
    } else if (ev.kind === 'kicked') {
      const it = people.get(ev.personId);
      if (it) { it.person.roomId = null; it.person.role = null; }
      send(ev.personId, { type: 'kicked', roomId: ev.roomId });
    }
  }
  if (lobbyDirty) sendLobby();
}

/* ---------- 訊息分派 ---------- */

function handle(person, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  const id = person.id;
  switch (msg.type) {
    case 'hello': {
      if (typeof msg.name === 'string') person.name = hub.cleanName(msg.name);
      send(id, { type: 'lobby', rooms: hub.listRooms() });
      break;
    }
    case 'create': {
      if (person.roomId) hub.leave(person);
      person.name = hub.cleanName(msg.name);
      const r = hub.createRoom(person, { difficulty: msg.difficulty, listed: msg.listed });
      send(id, { type: 'joined', role: 'player', roomId: r.room.id, notice: null });
      break;
    }
    case 'join': {
      if (person.roomId) hub.leave(person);
      person.name = hub.cleanName(msg.name);
      const r = hub.join(person, msg.roomId, { token: msg.token, want: msg.want });
      if (!r.ok) { errorTo(id, r.code, ERR[r.code] || '無法加入'); break; }
      send(id, { type: 'joined', role: r.role, roomId: r.room.id, notice: r.notice || null });
      send(id, { type: 'chat_history', chat: r.room.chat });
      break;
    }
    case 'resume': {
      const r = hub.resume(person, msg.roomId);
      if (!r.ok) { errorTo(id, r.code, ERR[r.code] || '無法回到房間'); send(id, { type: 'closed', roomId: msg.roomId, reason: r.code }); break; }
      send(id, { type: 'joined', role: r.role, roomId: r.room.id, notice: 'resumed' });
      send(id, { type: 'chat_history', chat: r.room.chat });
      break;
    }
    case 'leave': hub.leave(person); send(id, { type: 'lobby', rooms: hub.listRooms() }); break;
    case 'ready': hub.setReady(person, msg.on); break;
    case 'difficulty': hub.setDifficulty(person, msg.value); break;
    case 'listed': hub.setListed(person, msg.value); break;
    case 'invite_regen': hub.regenInvite(person); break;
    case 'add_cpu': { const r = hub.addCpu(person, msg.skill); if (r && !r.ok) errorTo(id, r.code, ERR[r.code] || (r.code === 'seats_full' ? '座位已滿' : '不能這樣做')); break; }
    case 'kick': hub.kick(person, String(msg.id || '')); break;
    case 'start': {
      const r = hub.start(person);
      if (!r.ok) errorTo(id, r.code, ERR[r.code] || '現在不能開局');
      break;
    }
    case 'again': hub.again(person); break;
    case 'score': hub.report(person, msg); break;
    case 'snap': hub.snap(person, msg); break;
    case 'chat': {
      const r = hub.chat(person, msg.text);
      if (r) for (const mid of hub.members(r.room)) send(mid, { type: 'chat', msg: r.msg });
      break;
    }
    case 'ping': send(id, { type: 'pong', t: msg.t, now: Date.now() }); break;
  }
  flush();
}

/* ---------- 計時（結束判定）與觀戰畫面 ---------- */

setInterval(() => { hub.tick(); flush(); }, 250).unref();

setInterval(() => {
  for (const room of hub.rooms.values()) {
    if (room.phase !== 'playing') continue;
    const sp = hub.specs(room);
    if (!sp.length) continue;
    const snaps = hub.snapsOf(room);
    for (const s of sp) send(s.id, { type: 'snaps', s: snaps, t: Date.now() });
  }
}, 100).unref();

/* ---------- HTTP ---------- */

function counts() {
  let players = 0, spectators = 0;
  for (const room of hub.rooms.values()) {
    players += hub.livePlayers(room).length;
    spectators += hub.specs(room).length;
  }
  let lobby = 0;
  for (const it of people.values()) if (!it.person.roomId) lobby++;
  return { players, spectators, lobby };
}

const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { url = '/'; }
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);

  if (url === '/api/presence') {
    const c = counts();
    json(res, 200, { gameId: GAME_ID, online: people.size, players: c.players, spectators: c.spectators,
      lobby: c.lobby, rooms: hub.rooms.size, updatedAt: new Date().toISOString() });
    return;
  }
  if (url === '/api/rooms') { json(res, 200, { rooms: hub.listRooms(), seats: CONST.SEATS }); return; }
  if (url === '/health') {
    const c = counts();
    json(res, 200, { ok: true, game: GAME_ID, rooms: hub.rooms.size, players: c.players,
      spectators: c.spectators, online: people.size, difficulties: Rules.DIFF_LIST, time: Date.now() });
    return;
  }
  if (url === '/') url = '/index.html';
  const file = path.join(ROOT, path.normalize(url).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('不可以跑出 public 目錄'); return; }
  sendFile(res, file);
});

/* ---------- WebSocket ---------- */

ws.attach(server, {
  path: '/ws',
  onConnection(socket, req) {
    let person = null;
    const q = new URL(req.url || '/ws', 'http://x').searchParams;
    const key = String(q.get('key') || '').slice(0, 40);

    const ghost = key && byKey.get(key);
    if (ghost && ghost.person) {
      person = ghost.person;
      clearTimeout(ghost.timer);
      byKey.delete(key);
    } else {
      person = { id: 'p' + crypto.randomBytes(6).toString('hex'), name: '', roomId: null, role: null };
    }
    person.key = key;
    people.set(person.id, { socket, person });
    socket.sendJSON({ type: 'hello', game: GAME_ID, personId: person.id, resumeRoom: ghost ? person.roomId : null });

    socket.on('message', text => {
      let msg = null;
      try { msg = JSON.parse(text); } catch (e) { return; }
      try { handle(person, msg); }
      catch (e) {
        console.error('[proto] ' + (msg && msg.type) + ' 出錯：', e && e.message);
        errorTo(person.id, 'server', '伺服器處理這個動作時出錯了');
      }
    });

    socket.on('close', () => {
      if (people.get(person.id) && people.get(person.id).socket !== socket) return;   /* 已被新連線取代 */
      people.delete(person.id);
      const room = hub.rooms.get(person.roomId);
      const keepGhost = room && room.phase === 'playing' && hub.players(room).some(m => m.id === person.id);
      hub.markDisconnected(person);
      if (keepGhost && key && hub.rooms.get(person.roomId)) {
        /* 對局中斷線：保留身分一小段時間，讓他換連線回來 */
        const timer = setTimeout(() => { byKey.delete(key); }, RESUME_MS);
        timer.unref();
        byKey.set(key, { person, timer });
      }
      flush();
    });
  }
});

function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name in nets) for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal) out.push(net.address);
  return out;
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('彈珠籃球 已啟動');
    console.log('  本機：http://localhost:' + PORT);
    for (const ip of localAddresses()) console.log('  同網路：http://' + ip + ':' + PORT);
    console.log('  健康檢查：http://localhost:' + PORT + '/health');
  });
}

module.exports = { server, hub, people, PORT, handle };
