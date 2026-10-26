/* ===== net.js — 線上連線（原生 WebSocket，自動重連、冷啟動等待、時間校正）=====
 * 伺服器位置只從 Config.serverUrl 來（見 config.js），這裡不寫死任何網址。
 */
(function (root) {
  'use strict';

  var Config = root.Config;
  var ws = null, want = false, retry = 0, timer = null, pingTimer = null;
  var handlers = {}, stateHandlers = [];
  var offset = 0, rtt = 0;
  var state = 'idle';

  function getKey() {
    var k = '';
    try {
      k = root.sessionStorage.getItem('ph:key') || '';
      if (!k) {
        k = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
        root.sessionStorage.setItem('ph:key', k);
      }
    } catch (e) { k = k || Math.random().toString(36).slice(2, 12); }
    return k;
  }

  function setState(s, info) {
    state = s;
    if (root.ServerOutage) root.ServerOutage.state(s);
    var NL = root.NetworkLatency;
    if (NL) {
      if (s === 'open') { NL.setProbe(function () { send({ type: 'ping', t: Date.now() }); }); NL.setActive(true); }
      else if (s === 'closed') NL.report(null);
      else NL.setActive(false);
    }
    stateHandlers.forEach(function (fn) { fn(s, info); });
  }

  function wsUrl() {
    return Config.serverUrl.replace(/^http/i, 'ws') + '/ws?key=' + encodeURIComponent(getKey());
  }

  function emit(type, msg) {
    if (root.GameAnalytics) root.GameAnalytics.roomResponse(type, !!msg.room);
    (handlers[type] || []).forEach(function (fn) { fn(msg); });
  }

  /** 伺服器睡著時 /health 會失敗；輪詢到醒了再連 WebSocket */
  function wake(done) {
    var tries = 0;
    function poll() {
      if (!want) return;
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var to = setTimeout(function () { if (ctl) ctl.abort(); }, 6000);
      fetch(Config.serverUrl + '/health', { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
        .then(function (r) { clearTimeout(to); return r.ok ? r.json() : Promise.reject(); })
        .then(function () { done(); })
        .catch(function () {
          clearTimeout(to);
          if (!want) return;
          tries++;
          setState('waking', { tries: tries });
          timer = setTimeout(poll, 3000);
        });
    }
    poll();
  }

  function open() {
    if (!want) return;
    setState('connecting');
    try { ws = new WebSocket(wsUrl()); } catch (e) { scheduleRetry(); return; }
    var mine = ws;
    ws.onopen = function () {
      retry = 0;
      setState('open');
      startPing();
    };
    ws.onmessage = function (ev) {
      var msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'pong') {
        rtt = Date.now() - msg.t;
        offset = msg.now + rtt / 2 - Date.now();
        if (root.NetworkLatency) root.NetworkLatency.report(rtt);
        return;
      }
      if (msg.type === 'room' && msg.room && msg.room.serverNow && !rtt) offset = msg.room.serverNow - Date.now();
      emit(msg.type, msg);
    };
    ws.onclose = function () {
      if (mine !== ws) return;
      stopPing();
      ws = null;
      if (want) { setState('closed'); scheduleRetry(); } else setState('idle');
    };
    ws.onerror = function () { /* onclose 會接手 */ };
  }

  function scheduleRetry() {
    if (!want) return;
    retry++;
    var wait = Math.min(8000, 800 * Math.pow(1.7, retry));
    timer = setTimeout(function () { wake(open); }, wait);
  }

  function startPing() {
    stopPing();
    function ping() { send({ type: 'ping', t: Date.now() }); }
    ping();
    pingTimer = setInterval(ping, 5000);
  }
  function stopPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

  function send(msg) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
      if (root.GameAnalytics) root.GameAnalytics.roomRequest(msg);
      return true;
    }
    return false;
  }

  function connect() {
    if (!Config.serverUrl) { setState('unavailable'); return false; }
    if (want && (state === 'open' || state === 'connecting' || state === 'waking')) return true;
    want = true;
    setState('connecting');
    wake(open);
    return true;
  }

  function disconnect() {
    want = false;
    clearTimeout(timer);
    stopPing();
    if (ws) { try { ws.close(); } catch (e) { /* 忽略 */ } }
    ws = null;
    setState('idle');
  }

  root.Net = {
    connect: connect, disconnect: disconnect, send: send,
    on: function (type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    onState: function (fn) { stateHandlers.push(fn); },
    serverNow: function () { return Date.now() + offset; },
    getState: function () { return state; },
    isOpen: function () { return !!(ws && ws.readyState === 1); },
    getKey: getKey
  };
})(typeof self !== 'undefined' ? self : this);
