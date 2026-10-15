/* ===== lib/rooms.js — 房間、席位、觀戰、邀請、計時、聊天（純邏輯，不碰 socket）=====
 *
 * 線上玩法是「同台競分」：每個玩家在自己的瀏覽器裡玩同一張台（同難度、同種子），
 * 伺服器負責房間、倒數與統一的結束時間、收集並檢查各人回報的分數、廣播排行。
 *
 * 房間生命週期（以「實體玩家」為準）：
 *   房裡至少要有一位「連線中的真人玩家」才保留；AI（本遊戲沒有）與觀戰者都不算。
 *   實體玩家數降到 0 → 立即關閉：邀請失效、從大廳移除、通知房內剩下的人（觀戰者）。
 *   已關閉的房間不會因為重新連線而復活。
 *
 * 狀態變化都丟進 hub.outbox，由 protocol 層統一送出去。
 */
'use strict';

const crypto = require('crypto');
const Rules = require('../public/js/rules.js');

const CONST = {
  SEATS: 4,
  SPECS: 20,
  COUNTDOWN_MS: 4000,
  GRACE_MS: 3500,            /* 結束時間到了之後，等玩家回報最後一筆分數的寬限 */
  INVITE_TTL_MS: 6 * 3600 * 1000,
  CHAT_KEEP: 60,
  NAME_MAX: 12
};

const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ADJ = ['快速', '安靜', '閃亮', '勇敢', '圓圓', '跳跳', '神準', '穩穩', '火熱', '冰涼'];
const ANI = ['小貓', '企鵝', '柴犬', '貓頭鷹', '海豹', '小熊', '狐狸', '河馬', '浣熊', '鴨鴨'];

function randomName() {
  return ADJ[Math.floor(Math.random() * ADJ.length)] + ANI[Math.floor(Math.random() * ANI.length)];
}

/** 暱稱一律在伺服器消毒：去控制字元與角括號、限長、空白就給隨機名 */
function cleanName(raw) {
  let s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = Array.from(s).slice(0, CONST.NAME_MAX).join('');
  return s || randomName();
}

function cleanText(raw) {
  return Array.from(String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()).slice(0, 80).join('');
}

function token() { return crypto.randomBytes(9).toString('base64url'); }

function createHub(opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  const rooms = new Map();
  const hub = { rooms, CONST, outbox: [] };

  function newRoomId() {
    for (let n = 0; n < 50; n++) {
      let id = '';
      for (let i = 0; i < 5; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
      if (!rooms.has(id)) return id;
    }
    return 'R' + Date.now().toString(36).toUpperCase();
  }

  function queue(kind, data) { hub.outbox.push(Object.assign({ kind }, data)); }
  function touch(room) { queue('room', { roomId: room.id }); }

  function players(room) { return Array.from(room.members.values()).filter(m => m.role === 'player'); }
  function specs(room) { return Array.from(room.members.values()).filter(m => m.role === 'spec'); }
  function livePlayers(room) { return players(room).filter(m => m.connected); }

  function makeInvites(room) {
    const t = now() + CONST.INVITE_TTL_MS;
    /* 舊的（已撤銷）token 留著，這樣對方點到舊連結會看到「已被撤銷」而不是「無效」 */
    room.invites[token()] = { role: 'play', expiresAt: t, revoked: false };
    room.invites[token()] = { role: 'watch', expiresAt: t, revoked: false };
  }

  function inviteOf(room, role) {
    for (const k of Object.keys(room.invites)) {
      const v = room.invites[k];
      if (v.role === role && !v.revoked) return k;
    }
    return null;
  }

  function newMember(person, role) {
    return {
      id: person.id, name: person.name, role, ready: false, connected: true,
      score: 0, hoops: 0, combo: 0, done: false, lastT: 0, snap: null, joinedAt: now()
    };
  }

  function removeMember(room, id) {
    room.members.delete(id);
  }

  function pickHost(room) {
    const m = livePlayers(room)[0];
    room.hostId = m ? m.id : null;
  }

  /** 關閉房間：邀請失效、從大廳移除，通知所有還在房內的人 */
  function closeRoom(room, reason) {
    if (room.closed) return;
    room.closed = true;
    room.closedReason = reason;
    Object.keys(room.invites).forEach(k => { room.invites[k].revoked = true; });
    const ids = Array.from(room.members.keys());
    rooms.delete(room.id);
    queue('closed', { roomId: room.id, memberIds: ids, reason });
    queue('lobby', {});
  }

  /** 每次人數變動後呼叫：沒有連線中的真人玩家就關房，否則必要時換房主 */
  function checkAlive(room) {
    if (room.closed) return;
    if (livePlayers(room).length === 0) { closeRoom(room, 'no-players'); return; }
    if (!room.hostId || !room.members.get(room.hostId) || !room.members.get(room.hostId).connected) pickHost(room);
  }

  /* ---------- 建立與加入 ---------- */

  hub.createRoom = function (person, o) {
    o = o || {};
    const diff = Rules.DIFFS[o.difficulty] ? o.difficulty : 'normal';
    const room = {
      id: newRoomId(), closed: false, phase: 'lobby',
      difficulty: diff, listed: o.listed !== false,
      hostId: person.id, members: new Map(), invites: {}, chat: [],
      seed: 0, startAt: 0, endsAt: 0, result: null, createdAt: now(), round: 0
    };
    makeInvites(room);
    const m = newMember(person, 'player');
    m.ready = true;
    room.members.set(person.id, m);
    rooms.set(room.id, room);
    person.roomId = room.id;
    person.role = 'player';
    queue('lobby', {});
    touch(room);
    return { ok: true, room };
  };

  /**
   * 加入房間。伺服器以 token 決定最終角色，暱稱只是顯示用，改暱稱不會改權限。
   * opts: { token, want: 'play' | 'watch' }
   */
  hub.join = function (person, roomId, o) {
    o = o || {};
    const room = rooms.get(String(roomId || '').toUpperCase());
    if (!room || room.closed) return { ok: false, code: 'room_closed' };
    let role = o.want === 'watch' ? 'watch' : 'play';

    if (o.token) {
      const inv = room.invites[o.token];
      if (!inv) return { ok: false, code: 'invite_invalid' };
      if (inv.revoked) return { ok: false, code: 'invite_revoked' };
      if (inv.expiresAt < now()) return { ok: false, code: 'invite_expired' };
      role = inv.role;               /* 以邀請決定角色，不看使用者填的 */
    } else if (!room.listed) {
      return { ok: false, code: 'invite_required' };
    }

    if (room.members.has(person.id)) return { ok: true, role: room.members.get(person.id).role, room };

    let notice = null, asRole = 'spec';
    if (role === 'play') {
      if (room.phase !== 'lobby') notice = 'match_running';
      else if (players(room).length >= CONST.SEATS) notice = 'seats_full';
      else asRole = 'player';
    }
    if (asRole === 'spec' && specs(room).length >= CONST.SPECS) return { ok: false, code: 'spec_full' };

    const m = newMember(person, asRole);
    room.members.set(person.id, m);
    person.roomId = room.id;
    person.role = asRole;
    queue('lobby', {});
    touch(room);
    return { ok: true, role: asRole, notice, room };
  };

  hub.leave = function (person) {
    const room = rooms.get(person.roomId);
    person.roomId = null; person.role = null;
    if (!room) return;
    const m = room.members.get(person.id);
    if (!m) return;
    if (room.phase === 'playing' && m.role === 'player') {
      m.connected = false; m.done = true; m.ready = false;
    } else {
      removeMember(room, person.id);
    }
    checkAlive(room);
    if (!room.closed) { touch(room); queue('lobby', {}); maybeFinish(room); }
  };

  hub.markDisconnected = function (person) {
    const room = rooms.get(person.roomId);
    if (!room) return;
    const m = room.members.get(person.id);
    if (!m) return;
    m.connected = false;
    if (room.phase === 'playing' && m.role === 'player') { m.done = true; }
    else removeMember(room, person.id);
    checkAlive(room);
    if (!room.closed) { touch(room); queue('lobby', {}); maybeFinish(room); }
  };

  /** 對局中斷線後換新連線回來（同一個人）。已關閉的房間不會復活。 */
  hub.resume = function (person, roomId) {
    const room = rooms.get(String(roomId || '').toUpperCase());
    if (!room || room.closed) return { ok: false, code: 'room_closed' };
    const m = room.members.get(person.id);
    if (!m) return { ok: false, code: 'not_member' };
    m.connected = true;
    if (room.phase === 'playing' && room.endsAt > now()) m.done = false;
    person.roomId = room.id;
    person.role = m.role;
    touch(room);
    return { ok: true, room, role: m.role };
  };

  /* ---------- 房間設定與開局 ---------- */

  function hostOnly(person) {
    const room = rooms.get(person.roomId);
    if (!room || room.hostId !== person.id) return null;
    return room;
  }

  hub.setReady = function (person, on) {
    const room = rooms.get(person.roomId);
    const m = room && room.members.get(person.id);
    if (!m || m.role !== 'player' || room.phase !== 'lobby') return;
    m.ready = !!on;
    touch(room);
  };

  hub.setDifficulty = function (person, diff) {
    const room = hostOnly(person);
    if (!room || room.phase !== 'lobby' || !Rules.DIFFS[diff]) return;
    room.difficulty = diff;
    touch(room); queue('lobby', {});
  };

  hub.setListed = function (person, listed) {
    const room = hostOnly(person);
    if (!room) return;
    room.listed = !!listed;
    touch(room); queue('lobby', {});
  };

  hub.regenInvite = function (person) {
    const room = hostOnly(person);
    if (!room) return;
    Object.keys(room.invites).forEach(k => { room.invites[k].revoked = true; });
    makeInvites(room);
    touch(room);
  };

  hub.kick = function (person, targetId) {
    const room = hostOnly(person);
    if (!room || targetId === person.id) return null;
    const m = room.members.get(targetId);
    if (!m) return null;
    removeMember(room, targetId);
    queue('kicked', { personId: targetId, roomId: room.id });
    touch(room); queue('lobby', {});
    return targetId;
  };

  hub.start = function (person) {
    const room = hostOnly(person);
    if (!room || room.phase !== 'lobby') return { ok: false, code: 'bad_phase' };
    const live = livePlayers(room);
    if (live.length < 2) return { ok: false, code: 'need_two' };
    if (live.some(m => m.id !== room.hostId && !m.ready)) return { ok: false, code: 'not_ready' };
    const d = Rules.DIFFS[room.difficulty];
    room.phase = 'playing';
    room.round++;
    room.seed = crypto.randomBytes(4).readUInt32BE(0);
    room.startAt = now() + CONST.COUNTDOWN_MS;
    room.endsAt = room.startAt + d.duration * 1000;
    room.result = null;
    players(room).forEach(m => { m.score = 0; m.hoops = 0; m.combo = 0; m.done = !m.connected; m.snap = null; m.lastT = 0; });
    touch(room); queue('lobby', {});
    return { ok: true, room };
  };

  /** 玩家回報分數。只收單調遞增、速度合理的值，回報的最大值不可能超過物理上限。 */
  hub.report = function (person, d) {
    const room = rooms.get(person.roomId);
    const m = room && room.members.get(person.id);
    if (!m || m.role !== 'player' || room.phase !== 'playing') return;
    const t = now();
    if (t < room.startAt - 500 || t > room.endsAt + CONST.GRACE_MS) return;
    const score = Math.floor(Number(d && d.score));
    if (!isFinite(score) || score < m.score) return;
    const elapsed = Math.max(0, (Math.min(t, room.endsAt) - room.startAt) / 1000);
    if (score > elapsed * 120 + 300) return;          /* 超過物理可能的速度，丟掉 */
    m.score = score;
    m.hoops = Math.max(0, Math.min(999, Math.floor(Number(d.hoops) || 0)));
    m.combo = Math.max(0, Math.min(Rules.COMBO_MAX, Math.floor(Number(d.combo) || 0)));
    m.ballNo = Math.max(0, Math.min(99, Math.floor(Number(d.ballNo) || 0)));
    if (d.done) m.done = true;
    touch(room);
    maybeFinish(room);
  };

  hub.snap = function (person, d) {
    const room = rooms.get(person.roomId);
    const m = room && room.members.get(person.id);
    if (!m || m.role !== 'player' || room.phase !== 'playing') return;
    if (!d || !Array.isArray(d.b) && d.b !== null) return;
    const num = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 10) / 10 : 0;
    m.snap = {
      b: d.b ? [num(d.b[0]), num(d.b[1]), num(d.b[2])] : null,
      f: [num(d.f && d.f[0]), num(d.f && d.f[1])],
      h: num(d.h), s: m.score, c: m.combo
    };
  };

  function maybeFinish(room) {
    if (room.closed || room.phase !== 'playing') return;
    const t = now();
    const live = livePlayers(room);
    const allDone = live.length > 0 && live.every(m => m.done);
    if (allDone || t >= room.endsAt + CONST.GRACE_MS) finishRoom(room);
  }

  function finishRoom(room) {
    room.phase = 'ended';
    const rank = players(room).slice().sort((a, b) => b.score - a.score || b.hoops - a.hoops);
    let place = 0, last = null;
    room.result = rank.map((m, i) => {
      if (!last || m.score !== last.score) place = i + 1;
      last = m;
      return { id: m.id, name: m.name, score: m.score, hoops: m.hoops, place, connected: m.connected };
    });
    queue('ended', { roomId: room.id });
    touch(room); queue('lobby', {});
  }

  /** 「再來一局」：任何玩家都能把已結束的房間重置回等待狀態 */
  hub.again = function (person) {
    const room = rooms.get(person.roomId);
    const m = room && room.members.get(person.id);
    if (!m || m.role !== 'player') return { ok: false };
    if (room.phase === 'ended') {
      room.phase = 'lobby';
      room.result = null;
      players(room).forEach(p => {
        if (!p.connected) removeMember(room, p.id);
        else { p.ready = false; p.score = 0; p.hoops = 0; p.combo = 0; p.done = false; p.snap = null; }
      });
      checkAlive(room);
      if (room.closed) return { ok: false };
      queue('lobby', {});
    }
    if (room.phase === 'lobby') {
      const me = room.members.get(person.id);
      if (me) me.ready = true;
      touch(room);
      return { ok: true };
    }
    return { ok: false };
  };

  /* ---------- 聊天 ---------- */

  hub.chat = function (person, text) {
    const room = rooms.get(person.roomId);
    const m = room && room.members.get(person.id);
    if (!m) return null;
    const t = cleanText(text);
    if (!t) return null;
    const ts = now();
    m.chatTimes = (m.chatTimes || []).filter(x => ts - x < 5000);
    if (m.chatTimes.length >= 5) return null;                 /* 5 秒最多 5 句 */
    m.chatTimes.push(ts);
    const msg = { id: m.id, name: m.name, role: m.role, text: t, t: ts };
    room.chat.push(msg);
    if (room.chat.length > CONST.CHAT_KEEP) room.chat.shift();
    return { room, msg };
  };

  /* ---------- 定時檢查 ---------- */

  hub.tick = function () {
    for (const room of Array.from(rooms.values())) maybeFinish(room);
  };

  /* ---------- 給前端看的資料 ---------- */

  hub.listRooms = function () {
    const out = [];
    for (const room of rooms.values()) {
      if (!room.listed || room.closed) continue;
      const d = Rules.DIFFS[room.difficulty];
      const host = room.members.get(room.hostId);
      out.push({
        id: room.id, difficulty: room.difficulty, difficultyName: d.name, phase: room.phase,
        players: players(room).length, seats: CONST.SEATS, specs: specs(room).length,
        host: host ? host.name : ''
      });
    }
    return out;
  };

  hub.viewFor = function (room, personId) {
    const me = room.members.get(personId);
    const isHost = room.hostId === personId;
    const view = {
      id: room.id, phase: room.phase, difficulty: room.difficulty, listed: room.listed,
      round: room.round, seed: room.phase === 'lobby' ? 0 : room.seed,
      startAt: room.startAt, endsAt: room.endsAt, serverNow: now(),
      hostId: room.hostId, seats: CONST.SEATS,
      players: players(room).map(m => ({
        id: m.id, name: m.name, ready: m.ready, connected: m.connected,
        score: m.score, hoops: m.hoops, combo: m.combo, ballNo: m.ballNo || 0,
        done: m.done, isHost: m.id === room.hostId
      })),
      specs: specs(room).map(m => ({ id: m.id, name: m.name })),
      result: room.result,
      you: me ? { id: me.id, role: me.role, isHost: isHost, name: me.name } : null
    };
    if (isHost) {
      view.invite = { play: inviteOf(room, 'play'), watch: inviteOf(room, 'watch') };
    }
    return view;
  };

  /** 只給觀戰者看的即時畫面 */
  hub.snapsOf = function (room) {
    const out = {};
    players(room).forEach(m => { if (m.snap) out[m.id] = m.snap; });
    return out;
  };

  hub.members = function (room) { return Array.from(room.members.keys()); };
  hub.players = players;
  hub.specs = specs;
  hub.livePlayers = livePlayers;
  hub.cleanName = cleanName;
  hub.cleanText = cleanText;
  hub.drain = function () { const o = hub.outbox; hub.outbox = []; return o; };

  return hub;
}

module.exports = { createHub, CONST, cleanName, cleanText };
