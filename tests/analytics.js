'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const sourcePath = fs.existsSync(path.join(root, 'public/js/analytics.js'))
  ? path.join(root, 'public/js/analytics.js') : path.join(root, 'analytics.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function client(hostname = 'pjh-eric.github.io', options = {}) {
  const calls = [], scripts = [], listeners = {};
  let time = 1000;
  class Clock extends Date { static now() { return time; } }
  const browser = {
    GAME_ANALYTICS_CONFIG: { measurement_id: 'G-TEST123', game_id: 'test-game', page_location: 'https://pjh-eric.github.io/test-game/' },
    location: { hostname, href: 'https://' + hostname + '/test-game/?campaign=private-value#private-anchor' },
    document: {
      referrer: 'https://pjh-eric.github.io/other/?name=private-name#private-hash', title: 'Test',
      createElement() { return {}; }, head: { appendChild(script) { scripts.push(script); } },
      addEventListener(name, fn) { listeners[name] = fn; }
    },
    I18N: { lang: 'en' },
    ...options
  };
  if (hostname === 'pjh-eric.github.io') browser.gtag = (...args) => calls.push(args);
  const context = { window: browser, URL, Date: Clock };
  vm.runInNewContext(source, context);
  return { browser, api: browser.GameAnalytics, calls, scripts, listeners, context, advance(ms) { time += ms; } };
}

const c = client();
assert.equal(c.scripts.length, 1, '只載入一次 Google tag');
const config = c.calls.find(call => call[0] === 'config')[2];
assert.equal(config.page_location, 'https://pjh-eric.github.io/test-game/');
assert.equal(config.page_referrer, 'https://pjh-eric.github.io/other/');
assert.equal(config.send_page_view, true);
assert.equal(config.allow_google_signals, false);
c.api.init(c.browser.GAME_ANALYTICS_CONFIG);
vm.runInNewContext(source, c.context);
assert.equal(c.scripts.length, 1, '初始化／腳本重複載入不重送 config 或 page_view');

const events = () => c.calls.filter(call => call[0] === 'event');
c.api.start({ mode: 'solo', players: 1, difficulty: 'hard', nickname: 'private-name', token: 'private-token' }, 'round-a');
c.api.start({ mode: 'solo', players: 1 }, 'round-a');
c.advance(3200);
c.api.end({ result: 'loss', private_code: 'private-code' });
c.api.end({ result: 'win' });
assert.equal(events().length, 2);
assert.equal(events()[0][2].mode, 'solo');
assert.equal(events()[1][2].result, 'lose');
assert.equal(events()[1][2].duration_sec, 3);
assert.equal(events()[1][2].game_id, 'test-game');
assert.equal(events()[1][2].app_language, 'en');
assert.equal(events()[1][2].transport_type, 'beacon');
assert.ok(!JSON.stringify(c.calls).includes('private-'), '參數、page_location、referrer 不帶個人資料');

c.api.start({ mode: 'solo' }, 'round-b');
c.api.start({ mode: 'solo' }, 'round-a');
assert.equal(events().length, 3, '重複的舊對局 key 不會重開');
c.api.sync('over', 'round-a', { mode: 'solo' }, { result: 'win' });
assert.equal(events().length, 3, '舊結算不可結束新對局');
c.api.sync('over', 'round-b', { mode: 'solo' }, { result: 'draw' });
assert.equal(events().length, 4);
c.api.reset();
c.api.start({ mode: 'solo' }, 'round-b');
assert.equal(events().length, 4, '離開／返回不清除已計數對局');
c.api.start({ mode: 'practice', players: 1 });
c.api.end({ result: 'complete' });
assert.equal(events()[4][2].mode, 'solo');
assert.equal(events()[4][2].variant, 'practice');
c.api.start({ mode: 'solo_random', players: 1 });
c.api.end({ result: 'complete' });
assert.equal(events()[6][2].variant, 'solo_random');

c.api.start({ mode: 'online', players: 2 }, 'legacy-online');
c.api.end({ result: 'complete' }, 'legacy-online');
assert.equal(events().at(-1)[2].mode, undefined, '線上模式不得上報');
c.api.start({ mode: 'spectator', players: 1 }, 'legacy-spectator');
c.api.end({ result: 'complete' }, 'legacy-spectator');
assert.equal(events().at(-1)[2].mode, undefined, '觀戰模式不得上報');
c.api.start({ mode: 'multiplayer', players: 2 }, 'legacy-multiplayer');
c.api.end({ result: 'complete' }, 'legacy-multiplayer');
assert.equal(events().at(-1)[2].mode, undefined, '多人模式不得上報');

const beforeLegacyEvents = events().length;
c.api.track('room_create');
assert.equal(events().length, beforeLegacyEvents);
c.api.track('room_join');
assert.equal(events().length, beforeLegacyEvents);
c.api.track('room_leave');
assert.equal(events().length, beforeLegacyEvents);
c.api.track('chat_message');
assert.equal(events().length, beforeLegacyEvents);
c.api.track('invite_share');
assert.equal(events().length, beforeLegacyEvents);
c.api.track('spectator_join');
assert.equal(events().length, beforeLegacyEvents);

const beforeInvalid = events().length;
c.api.track('nickname', { name: 'private-name' });
assert.equal(events().length, beforeInvalid, '只接受已定義事件');
c.api.track('game_end', { mode: 'unknown', players: Infinity, duration_sec: -1, result: 'private-name', url: 'private-url' });
for (const key of ['mode', 'players', 'duration_sec', 'result', 'url']) assert.equal(events().at(-1)[2][key], undefined);
c.browser.gtag = () => { throw new Error('blocked'); };
assert.doesNotThrow(() => c.api.track('game_start'));
delete c.browser.gtag;
assert.doesNotThrow(() => c.api.track('game_start'));

for (const hostname of ['localhost', '127.0.0.1', 'preview.example', '']) {
  const local = client(hostname);
  assert.equal(local.scripts.length, 0);
  assert.equal(local.browser.gtag, undefined);
  assert.doesNotThrow(() => local.api.start({ mode: 'solo', players: 1 }));
}
const maze = client('pjh-eric.github.io', { MR_CONFIG: { ga4MeasurementId: 'G-MAZE123' } });
assert.equal(maze.browser.MR_ANALYTICS, maze.api, '保留迷宮滾球畫面追蹤 API');
assert.equal(maze.calls.find(call => call[0] === 'config')[2].send_page_view, false);
maze.api.pageView('home');
maze.api.pageView('home');
maze.api.pageView('game');
assert.equal(maze.calls.filter(call => call[1] === 'page_view').length, 2);
assert.ok(!JSON.stringify(maze.calls).includes('private-'));
console.log('GA4 verified: initialization, local isolation, solo lifecycle, parameters and native screen views');
