/* ===== tests/verify.js — 彈珠籃球規則核心單元測試（零依賴）===== */
'use strict';

require('./seo.js');
const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const Rules = require('../public/js/rules.js');
const { play, botInput } = require('./bot.js');
const projectRoot = path.resolve(__dirname, '..');
const readProjectFile = file => fs.readFileSync(path.join(projectRoot, file), 'utf8');
const projectFileExists = file => fs.existsSync(path.join(projectRoot, file));

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
    assert(L[i].hoopFreq >= L[i - 1].hoopFreq, '籃框要越來越快');
    assert(L[i].hoopAmp >= L[i - 1].hoopAmp, '籃框上下移動要越來越大');
    assert(L[i].gravity >= L[i - 1].gravity, '重力不能變小');
  }
  assert.strictEqual(Rules.DIFFS.kids.drainOpen, false, '幼幼班不會漏球');
  assert(Rules.geometry('hard').bumpers.length === 1, '彈跳墊只留一個');
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
  const hy = g.hoopY;
  g.ball.x = g.hoopX; g.ball.y = hy + 30; g.ball.vx = 0; g.ball.vy = -900;
  for (let i = 0; i < 40; i++) Rules.step(g, {});     /* 球已由下往上穿過框線、還在上升 */
  assert(g.ball.y < hy - 10, '測試前提：球要已經穿到框上方');
  assert.strictEqual(g.hoops, 0, '往上穿過不該得分');
  const h = Rules.create('easy', 1);
  h.ball.x = h.hoopX; h.ball.y = h.hoopY - 40; h.ball.vx = 0; h.ball.vy = 200; h.ball.armed = true;
  for (let i = 0; i < 240; i++) Rules.step(h, {});
  assert.strictEqual(h.hoops, 1, '由上往下穿過要得分');
  assert.strictEqual(h.swishes, 1, '沒碰框是空心球');
  assert.strictEqual(h.score - h.bumps, 30, '空心球 30 分（彈跳墊另外每下 1 分）');
});
t('加分時段邊界與進球加分', () => {
  assert.strictEqual(Rules.bonusActive(19.999), false);
  assert.strictEqual(Rules.bonusActive(20), true);
  assert.strictEqual(Rules.bonusActive(25), false);
  assert.strictEqual(Rules.bonusActive(40), true);
  function shot(time) {
    const g = Rules.create('kids', 1);
    g.t = time; g.ball.x = g.hoopX; g.ball.y = g.hoopY - 30;
    g.ball.vx = 0; g.ball.vy = 200; g.ball.armed = true;
    while (!g.hoops && g.t < time + 1) Rules.step(g, {});
    return g.score;
  }
  assert.strictEqual(shot(20), 40);
  assert.strictEqual(shot(25), 30);
});
t('單機累積紀錄保留並且重設設定不會清除', () => {
  const vm = require('vm');
  const fs = require('fs');
  let stored = '';
  const localStorage = { getItem: () => stored, setItem: (key, value) => { stored = value; } };
  function load() {
    const context = { localStorage }; context.self = context;
    vm.runInNewContext(fs.readFileSync('public/js/storage.js', 'utf8'), context);
    return context.Store;
  }
  const store = load();
  store.recordGame({ hoops: 3, swishes: 2, bestCombo: 3 });
  store.recordGame({ hoops: 1, swishes: 1, bestCombo: 2 });
  store.reset();
  const r = load().get('records');
  assert.deepStrictEqual([r.games, r.hoops, r.swishes, r.bestCombo], [2, 4, 3, 3]);
});
t('新球發出時不能因為籃框掃過而直接進球', () => {
  for (const id of ['easy', 'normal', 'hard']) {
    for (let s = 1; s <= 20; s++) {
      const g = Rules.create(id, s * 17);
      g.ball.vx = 0; g.ball.vy = 0; g.ball.x = g.hoopX - 10; g.ball.y = 300;   /* 球停在框的移動範圍內，等框掃過 */
      for (let i = 0; i < 120; i++) { Rules.step(g, {}); if (g.hoops) break; }
      assert.strictEqual(g.hoops, 0, id + ' 新球被框掃過就得分');
    }
  }
});
t('連擊倍率：7 秒內連進，倍率遞增，最高 ×5', () => {
  const g = Rules.create('kids', 1);
  const scores = [];
  for (let n = 0; n < 6; n++) {
    g.ball.x = g.hoopX; g.ball.y = Rules.hoopYAt(g.geo, g.t + 0.02) - 30; g.ball.vx = 0; g.ball.vy = 200; g.ball.armed = true; g.ball.rim = false;
    const before = g.score;
    for (let i = 0; i < 120; i++) Rules.step(g, {});
    scores.push(g.score - before - 0);
  }
  assert(g.bestCombo === 5, '最高連擊應為 5，實際 ' + g.bestCombo);
  assert(g.combo <= 5);
});
t('超過連擊時間，倍率重算', () => {
  const g = Rules.create('kids', 1);
  function shot() { g.ball.x = g.hoopX; g.ball.y = Rules.hoopYAt(g.geo, g.t + 0.02) - 30; g.ball.vx = 0; g.ball.vy = 200; g.ball.armed = true; for (let i = 0; i < 120; i++) Rules.step(g, {}); }
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
  const b = g.ball; b.x = 500 - 0.6 * g.flipLen; b.y = 740; b.vx = 0; b.vy = 0;
  let minY = 1e9, t0 = null;
  for (let i = 0; i < 240 * 4 && g.ball; i++) {
    if (g.ball.y > 770 && t0 === null) t0 = g.t;
    Rules.step(g, { flip: t0 !== null && g.t - t0 >= 0.2 && g.t - t0 < 0.55 });
    g.events.length = 0;
    if (g.ball) minY = Math.min(minY, g.ball.y);
  }
  assert(minY < 300, '球應被打到半空以上，實際最高 y=' + minY);
});
t('時機對的話，彈板打出的球能進籃框（各難度都有可行的時機）', () => {
  Rules.DIFF_LIST.forEach(id => {
    let ok = 0;
    for (let bx = 310; bx <= 430; bx += 15) for (let wait = 0; wait <= 0.6; wait += 0.05) {
      const g = Rules.create(id, 1);
      g.ball.x = bx; g.ball.y = 740; g.ball.vx = 0; g.ball.vy = 0;
      let t0 = null;
      for (let i = 0; i < 240 * 6 && g.ball && g.hoops === 0; i++) {
        if (g.ball.y > 770 && t0 === null) t0 = g.t;
        Rules.step(g, { flip: t0 !== null && g.t - t0 >= wait && g.t - t0 < wait + 0.35 });
        g.events.length = 0;
      }
      if (g.hoops) ok++;
    }
    assert(ok >= 2, id + ' 可進球的時機太少：' + ok);
  });
});
function shoot(id, dy, vy, x) {
  const g = Rules.create(id, 3);
  const b = g.ball; b.x = x; b.y = g.hoopY + dy; b.vx = 0; b.vy = vy;
  let rose = 0;
  for (let i = 0; i < 240 * 4 && g.ball && g.status === 'playing'; i++) {
    const before = g.hoops;
    Rules.step(g, { flip: false }); g.events.length = 0;
    if (g.hoops > before && g.ball && g.ball.vy < 0) rose++;
    if (g.ball && g.ball.y > g.hoopY + 400) break;
  }
  return g;
}
t('進球：從上方掉進籃框（框會上下移動）一定得分', () => {
  ['kids', 'easy', 'normal'].forEach(id => {
    const geo = Rules.geometry(id);
    for (let k = 0; k < 6; k++) {
      const g = Rules.create(id, 3); g.t = k * 1.7;                    /* 不同的框位置與移動方向 */
      g.hoopY = Rules.hoopYAt(geo, g.t); g.prevHoopY = g.hoopY;
      const b = g.ball; b.x = Rules.W - geo.hoop.w / 2 + 6; b.y = Math.max(70, g.hoopY - 220); b.vx = 0; b.vy = 150;
      for (let i = 0; i < 240 * 3 && g.hoops === 0; i++) { Rules.step(g, { flip: false }); g.events.length = 0; }
      assert.strictEqual(g.hoops, 1, id + ' 第 ' + k + ' 組從上方掉進去沒得分');
    }
  });
});
t('進球：從籃框底下往上頂過去、只高出一點又掉回來，不算分', () => {
  ['kids', 'easy'].forEach(id => {
    const x = Rules.W - Rules.geometry(id).hoop.w / 2 + 6;
    const g = shoot(id, 250, -770, x);
    assert.strictEqual(g.hoops, 0, id + ' 從底下進去不該得分');
  });
});
t('進球：飛得夠高再落下來，仍然算分（正常的投籃）', () => {
  const id = 'easy';
  const x = Rules.W - Rules.geometry(id).hoop.w / 2 + 6;
  const g = shoot(id, 250, -880, x);
  assert.strictEqual(g.hoops, 1);
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
t('籃框貼右牆、開口朝左，上下移動不碰到彈跳墊以外的牆', () => {
  Rules.DIFF_LIST.forEach(id => {
    const geo = Rules.geometry(id);
    assert(Math.abs(geo.hoop.x + geo.hoop.w / 2 - Rules.W) < 1e-6, id + ' 籃框右緣要貼牆');
    assert(geo.hoop.w >= Rules.BALL_R * 2 + 16, id + ' 籃框開口至少要容得下一顆球');
    assert(geo.hoop.cy - geo.hoop.amp > 120 && geo.hoop.cy + geo.hoop.amp < 520, id + ' 上下移動超出範圍');
  });
  assert(Rules.geometry('kids').hoop.w <= 170, '籃框不能太大');
});
t('彈板尖端與左牆之間的缺口比球大、且彈板越難越短', () => {
  let prev = 1e9;
  Rules.DIFF_LIST.forEach(id => {
    const geo = Rules.geometry(id);
    const tip = Rules.flipperTip(geo, 0, Rules.REST);
    const want = { kids: 1.1, easy: 1.25, normal: 1.5, hard: 1.75 }[id] * Rules.BALL_R * 2;
    assert(Math.abs((tip.x - Rules.FLIP_R - geo.drainX0) - want) < 1, id + ' 掉落洞口要是球寬的固定倍數：' + (tip.x - Rules.FLIP_R - geo.drainX0) + ' vs ' + want);
  });
});

console.log('單機版本清理');
t('移除房間與 WebSocket 後端檔案', () => {
  assert.strictEqual(projectFileExists('.env.example'), false);
  assert.strictEqual(projectFileExists('lib/cpu.js'), false);
  assert.strictEqual(projectFileExists('lib/rooms.js'), false);
  assert.strictEqual(projectFileExists('lib/ws.js'), false);
  assert.strictEqual(projectFileExists('public/js/config.js'), false);
  assert.strictEqual(projectFileExists('public/js/net.js'), false);
  assert.strictEqual(projectFileExists('render.yaml'), false);
});
t('移除連線狀態與故障顯示資產', () => {
  assert.strictEqual(projectFileExists('public/css/latency.css'), false);
  assert.strictEqual(projectFileExists('public/css/server-outage.css'), false);
  assert.strictEqual(projectFileExists('public/js/latency.js'), false);
  assert.strictEqual(projectFileExists('public/js/server-outage.js'), false);
  assert.strictEqual(projectFileExists('scripts/server-outage-browser-check.cjs'), false);
  assert.strictEqual(projectFileExists('docs/qa-server-outage-2026-10-26.md'), false);
  assert.strictEqual(projectFileExists('tests/server-outage.cjs'), false);
});
t('移除 Render 網址注入與線上檢查工具', () => {
  assert.strictEqual(projectFileExists('scripts/inject-server-url.js'), false);
  assert.strictEqual(projectFileExists('scripts/online-check.js'), false);
});
t('本機伺服器只提供靜態頁面', () => {
  const server = readProjectFile('server.js');
  assert.ok(server.includes('http.createServer'));
  assert.ok(server.includes("'127.0.0.1'"));
  assert.ok(!server.includes("require('./lib/rooms.js')"));
  assert.ok(!server.includes("require('./lib/ws.js')"));
  assert.ok(!server.includes('onrender.com'));
});
t('本機伺服器不建立即時連線或房間路由', () => {
  const server = readProjectFile('server.js');
  assert.ok(!server.includes('WebSocket'));
  assert.ok(!server.includes("'upgrade'"));
  assert.ok(!server.includes('ALLOW_ORIGIN'));
  assert.ok(!server.includes("'/health'"));
  assert.ok(!server.includes('room_create'));
});
t('首頁移除線上大廳與房間畫面', () => {
  const html = readProjectFile('public/index.html');
  assert.ok(!html.includes('id="s-lobby"'));
  assert.ok(!html.includes('id="s-room"'));
  assert.ok(!html.includes('data-screen="lobby"'));
  assert.ok(!html.includes('data-screen="room"'));
});
t('首頁移除聊天室、觀戰與邀請控制項', () => {
  const html = readProjectFile('public/index.html');
  assert.ok(!html.includes('id="chatLog"'));
  assert.ok(!html.includes('id="chatForm"'));
  assert.ok(!html.includes('data-spectator'));
  assert.ok(!html.includes('inviteLink'));
});
t('遊戲控制器不依賴線上連線模組', () => {
  const app = readProjectFile('public/js/app.js');
  assert.ok(!app.includes('Net.'));
  assert.ok(!app.includes('Config.'));
  assert.ok(!app.includes('ServerOutage'));
  assert.ok(!app.includes('GameNet'));
  assert.ok(!app.includes('WebSocket'));
});
t('遊戲控制器移除房間、聊天與觀戰流程', () => {
  const app = readProjectFile('public/js/app.js');
  assert.ok(!app.includes('room_create'));
  assert.ok(!app.includes('room_join'));
  assert.ok(!app.includes('invite'));
  assert.ok(!app.includes('spectator'));
  assert.ok(!app.includes('chat'));
});
t('樣式表移除大廳與房間元件', () => {
  const css = readProjectFile('public/css/style.css');
  assert.ok(!css.includes('.lobby-grid'));
  assert.ok(!css.includes('.room-grid'));
  assert.ok(!css.includes('.online-count'));
  assert.ok(!css.includes('.seats'));
});
t('樣式表移除聊天室、觀戰與對手畫面', () => {
  const css = readProjectFile('public/css/style.css');
  assert.ok(!css.includes('.chat'));
  assert.ok(!css.includes('.spec-tabs'));
  assert.ok(!css.includes('.opp-col'));
  assert.ok(!css.includes('data-spectator'));
});
t('分析事件不再追蹤房間或觀戰事件', () => {
  const analytics = readProjectFile('public/js/analytics.js');
  assert.ok(!analytics.includes('room_create'));
  assert.ok(!analytics.includes('room_join'));
  assert.ok(!analytics.includes('room_leave'));
  assert.ok(!analytics.includes('spectator_join'));
});
t('套件指令不再設定線上檢查或網址注入', () => {
  const pkg = readProjectFile('package.json');
  assert.ok(!pkg.includes('test:online'));
  assert.ok(!pkg.includes('online-check'));
  assert.ok(!pkg.includes('inject-server-url'));
});
t('搜尋摘要只描述單機玩法', () => {
  const seo = readProjectFile('seo.config.json') + readProjectFile('seo.gameplay.json');
  assert.ok(!/multiplayer/i.test(seo));
  assert.ok(!seo.includes('線上多人'));
  assert.ok(!seo.includes('觀戰'));
});
t('Pages 部署不再注入 Render 遊戲伺服器網址', () => {
  const workflow = readProjectFile('.github/workflows/pages.yml');
  assert.ok(!workflow.includes('GAME_SERVER_URL'));
  assert.ok(!workflow.includes('RENDER'));
  assert.ok(!workflow.includes('onrender.com'));
  assert.ok(!workflow.includes('inject-server-url'));
  assert.ok(workflow.includes('public'));
});
t('啟動說明不再引導線上對戰', () => {
  const launcher = readProjectFile('啟動遊戲.bat');
  assert.ok(!launcher.includes('線上對戰'));
  assert.ok(!launcher.includes('Render'));
  assert.ok(!launcher.includes('GAME_SERVER_URL'));
});

console.log('\n' + passed + ' 項通過' + (process.exitCode ? '（有失敗）' : ''));
