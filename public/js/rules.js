/* ===== rules.js — 彈珠籃球的規則與物理核心（不碰 DOM）=====
 *
 * 一張固定大小的彈珠台（600×900，y 向下），一顆籃球、單一彈板（點畫面任何地方就揮板）、幾個彈跳墊、
 * 一個貼右牆、開口朝左、上下移動的籃框。球從上方穿過籃框 ＝ 得分（沒碰框的空心球 30 分，碰框進 20 分，
 * 連續進球有連擊倍率，最高 ×5；撞彈跳墊每下 1 分）。限時衝分。
 *
 * 全部使用固定步長（1/240 秒）與種子亂數，所以「同種子＋同操作」結果完全一致。
 */
(function (root) {
  'use strict';

  var Rng = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./rng.js') : root.Rng;

  var W = 600, H = 900;
  var STEP = 1 / 240;
  var BALL_R = 38;
  var MAX_SPEED = 1700;
  var REST = 0.16;             /* 彈板放下時的仰角（尖端略低） */
  var ACTIVE = -0.62;          /* 彈板揮起時的仰角 */
  var FLIP_W = 8;             /* 彈板角速度 rad/s */
  var PIVOT_Y = 790;
  var FLIP_R = 10;             /* 彈板粗細（半徑） */
  var COMBO_WINDOW = 7;        /* 秒：這段時間內再進球才算連擊 */
  var COMBO_MAX = 5;

  function bonusActive(t) { return t >= 20 && t % 20 < 5; }

  /* 四段難度：差別在籃框大小與移動、重力、球數、彈板與漏球空隙、彈跳墊數量 */
  var DIFFS = {
    kids: {
      id: 'kids', name: '幼幼班', blurb: '籃框超大、不會漏球，慢慢玩',
      duration: 120, balls: 0, gravity: 0.85, hoopW: 170, hoopAmp: 0, hoopFreq: 0.08,
      drainK: 1.1, flipLen: 280, pivotX: 500, drainOpen: false, bumpers: 1
    },
    easy: {
      id: 'easy', name: '簡單', blurb: '籃框大、動得慢，有 5 顆球',
      duration: 90, balls: 5, gravity: 0.85, hoopW: 140, hoopAmp: 40, hoopFreq: 0.10,
      drainK: 1.25, flipLen: 250, pivotX: 500, drainOpen: true, bumpers: 1
    },
    normal: {
      id: 'normal', name: '普通', blurb: '標準籃框，3 顆球',
      duration: 90, balls: 3, gravity: 1.0, hoopW: 114, hoopAmp: 70, hoopFreq: 0.16,
      drainK: 1.5, flipLen: 230, pivotX: 500, drainOpen: true, bumpers: 1
    },
    hard: {
      id: 'hard', name: '困難', blurb: '籃框小又快，漏球空隙大',
      duration: 90, balls: 3, gravity: 1.12, hoopW: 95, hoopAmp: 100, hoopFreq: 0.26,
      drainK: 1.75, flipLen: 205, pivotX: 500, drainOpen: true, bumpers: 1
    }
  };
  var DIFF_LIST = ['kids', 'easy', 'normal', 'hard'];

  var geoCache = {};

  /** 某個難度的固定場地（牆、導板、彈跳墊、彈板位置、籃框） */
  function geometry(diffId) {
    if (geoCache[diffId]) return geoCache[diffId];
    var d = DIFFS[diffId] || DIFFS.normal;
    var px = d.pivotX;
    var segs = [
      /* 外牆：左牆一路到底（球從這邊漏掉），右邊是順著滑向彈板的斜坡 */
      { ax: 0, ay: 150, bx: 0, by: 960, e: 0.45 },
      { ax: 0, ay: 150, bx: 150, by: 0, e: 0.45 },
      { ax: 150, ay: 0, bx: W - 50, by: 0, e: 0.35 },
      { ax: W - 50, ay: 0, bx: W, by: 50, e: 0.3 },
      { ax: W, ay: 50, bx: W, by: 280, e: 0.22 },
      { ax: W, ay: 320, bx: W, by: 280, e: 0.22 }
    ];
    /* 右下角圓弧導板（像四分之一圓管）：貼著右牆垂直切入，越往下越平，滑向彈板轉軸 */
    segs.pop();
    (function () {
      var a = 150, cx = W - a, cy = 280, phm = Math.acos((px + 4 - cx) / a), b = (PIVOT_Y - 6 - cy) / Math.sin(phm), N = 14, prev = { x: W, y: cy }, k, ph, pt;
      for (k = 1; k <= N; k++) {
        ph = (k / N) * (phm);
        pt = { x: cx + a * Math.cos(ph), y: cy + b * Math.sin(ph) };
        segs.push({ ax: prev.x, ay: prev.y, bx: pt.x, by: pt.y, e: 0.3 });
        prev = pt;
      }
      if (Math.abs(prev.x - (px + 4)) > 1) segs.push({ ax: prev.x, ay: prev.y, bx: px + 4, by: PIVOT_Y - 6, e: 0.3 });
    })();
    /* 只留一個彈跳墊，擺在球場中間偏左 */
    /* 掉落洞口（彈板尖端與左下導板之間的缺口）寬度＝球寬的 drainK 倍：幼幼班 1.1／簡單 1.25／普通 1.5／困難 1.75（越難洞口越大） */
    var flipLen = d.flipLen;
    var tipX = px - Math.cos(REST) * flipLen;
    var drainW = d.drainK * 2 * BALL_R;
    var xL = Math.max(20, tipX - FLIP_R - drainW);
    segs.push({ ax: 0, ay: 560, bx: xL, by: 745, e: 0.3 });        /* 左下導板：把球導向洞口 */
    segs.push({ ax: xL, ay: 745, bx: xL, by: 960, e: 0.3 });
    var bumpers = [{ x: 230, y: 430, r: 34 }];
    var geo = {
      W: W, H: H, segs: segs, bumpers: bumpers, diff: d,
      pivots: [{ x: px, y: PIVOT_Y }],
      flipDir: -1,                   /* 樞軸在右、尖端朝左 */
      flipLen: flipLen,
      /* 籃框固定在右牆上、開口朝左：籃板貼右牆，框從牆邊往左伸出；只會慢慢上下移動 */
      hoop: { w: d.hoopW, x: W - d.hoopW / 2, cy: 260, amp: d.hoopAmp, freq: d.hoopFreq },
      drainX0: xL, drainW: drainW,
      padY: 888                      /* 幼幼班的彈力墊（不漏球） */
    };
    geoCache[diffId] = geo;
    return geo;
  }

  function flipperTip(geo, i, a) {
    var p = geo.pivots[i];
    return { x: p.x + geo.flipDir * Math.cos(a) * geo.flipLen, y: p.y + Math.sin(a) * geo.flipLen };
  }

  function hoopXAt(geo) { return geo.hoop.x; }
  function hoopYAt(geo, t) {
    return geo.hoop.cy + geo.hoop.amp * Math.sin(2 * Math.PI * geo.hoop.freq * t);
  }

  /** unlimitedBalls：對戰模式不限球數，只有時間到才結束 */
  function create(diffId, seed, unlimitedBalls) {
    var d = DIFFS[diffId] || DIFFS.normal;
    var geo = geometry(d.id);
    var g = {
      diff: d, geo: geo, seed: seed >>> 0, unlimited: !!unlimitedBalls,
      t: 0, acc: 0, status: 'playing', overReason: null,
      score: 0, hoops: 0, swishes: 0, bumps: 0, combo: 0, bestCombo: 0, lastScoreT: -99,
      ballNo: 0, serveIndex: 0, respawnAt: 0, overAt: 0,
      ball: null,
      fl: [{ a: REST, w: 0 }],
      prevFlip: false,
      hoopX: hoopXAt(geo), hoopY: hoopYAt(geo, 0), prevHoopY: hoopYAt(geo, 0),
      bumperFlash: geo.bumpers.map(function () { return 0; }),
      bumperCd: geo.bumpers.map(function () { return 0; }),
      stuckT: 0,
      events: []
    };
    serve(g);
    return g;
  }

  function serve(g) {
    var i = g.serveIndex++;
    var r1 = Rng.at(g.seed, i * 2), r2 = Rng.at(g.seed, i * 2 + 1);
    g.ballNo++;
    g.ball = {
      x: 455 + r1 * 90, y: 300, vx: -(70 + r2 * 150), vy: 0,
      /* 發球點落在籃框上下移動的範圍內，框掃過球不能算進球：新球要先飛到框線上方才開始計分（armed） */
      r: BALL_R, rim: false, armed: false, fromBelow: false, spin: 0
    };
    g.stuckT = 0;
    g.events.push({ type: 'serve' });
  }

  /* ---------- 碰撞 ---------- */

  /** 球 vs 線段（含粗細 rad）。vs＝該點表面速度（彈板），回傳撞擊強度或 0 */
  function hitSegment(ball, ax, ay, bx, by, rad, e, svx, svy) {
    var abx = bx - ax, aby = by - ay;
    var len2 = abx * abx + aby * aby;
    var t = len2 > 0 ? ((ball.x - ax) * abx + (ball.y - ay) * aby) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var cx = ax + abx * t, cy = ay + aby * t;
    var dx = ball.x - cx, dy = ball.y - cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var minD = ball.r + rad;
    if (dist >= minD) return null;
    var nx, ny;
    if (dist > 1e-6) { nx = dx / dist; ny = dy / dist; }
    else { var l = Math.sqrt(len2) || 1; nx = -aby / l; ny = abx / l; }
    ball.x = cx + nx * minD;
    ball.y = cy + ny * minD;
    var sx = svx || 0, sy = svy || 0;
    var rvx = ball.vx - sx, rvy = ball.vy - sy;
    var vn = rvx * nx + rvy * ny;
    var impact = 0;
    if (vn < 0) {
      rvx -= (1 + e) * vn * nx;
      rvy -= (1 + e) * vn * ny;
      ball.vx = rvx + sx;
      ball.vy = rvy + sy;
      impact = -vn;
    }
    return { impact: impact, nx: nx, ny: ny, cx: cx, cy: cy, t: t };
  }

  function hitCircle(ball, x, y, rad, e) {
    var dx = ball.x - x, dy = ball.y - y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var minD = ball.r + rad;
    if (dist >= minD) return null;
    var nx, ny;
    if (dist > 1e-6) { nx = dx / dist; ny = dy / dist; } else { nx = 0; ny = -1; }
    ball.x = x + nx * minD;
    ball.y = y + ny * minD;
    var vn = ball.vx * nx + ball.vy * ny;
    var impact = 0;
    if (vn < 0) {
      ball.vx -= (1 + e) * vn * nx;
      ball.vy -= (1 + e) * vn * ny;
      impact = -vn;
    }
    return { impact: impact, nx: nx, ny: ny };
  }

  /* ---------- 一個固定步長 ---------- */

  function step(g, inp) {
    var geo = g.geo, d = g.diff, dt = STEP;
    g.t += dt;
    g.hoopX = geo.hoop.x;
    g.prevHoopY = g.hoopY;
    g.hoopY = hoopYAt(geo, g.t);
    var k;
    for (k = 0; k < g.bumperFlash.length; k++) {
      if (g.bumperFlash[k] > 0) g.bumperFlash[k] -= dt;
      if (g.bumperCd[k] > 0) g.bumperCd[k] -= dt;
    }

    /* 彈板：點一下（或按任意鍵）就揮起，放開就落下 */
    var wantUp = !!(inp.flip || inp.left || inp.right);
    var f = g.fl[0];
    var target = wantUp ? ACTIVE : REST;
    var prev = f.a;
    if (f.a < target) f.a = Math.min(target, f.a + FLIP_W * dt);
    else if (f.a > target) f.a = Math.max(target, f.a - FLIP_W * dt);
    f.w = (f.a - prev) / dt;
    if (wantUp && !g.prevFlip) g.events.push({ type: 'flip' });
    g.prevFlip = wantUp;
    var i;

    var b = g.ball;
    if (!b) {
      if (g.status === 'playing' && g.respawnAt && g.t >= g.respawnAt) { g.respawnAt = 0; serve(g); }
      return;
    }

    /* 球 */
    b.vy += 1300 * d.gravity * dt;
    var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (sp > MAX_SPEED) { b.vx *= MAX_SPEED / sp; b.vy *= MAX_SPEED / sp; }
    var prevY = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.spin += b.vx * dt * 0.04;

    var h, n;
    for (n = 0; n < geo.segs.length; n++) {
      var s = geo.segs[n];
      h = hitSegment(b, s.ax, s.ay, s.bx, s.by, 0, s.e);
      if (h && h.impact > 220) g.events.push({ type: 'wall', power: Math.min(1, h.impact / 900) });
    }

    /* 彈板 */
    for (i = 0; i < 1; i++) {
      var p = geo.pivots[i];
      var tip = flipperTip(geo, i, g.fl[i].a);
      /* 先算接觸點離樞軸多遠，才知道表面速度 */
      var abx = tip.x - p.x, aby = tip.y - p.y;
      var tt = ((b.x - p.x) * abx + (b.y - p.y) * aby) / (abx * abx + aby * aby);
      if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
      var rx = abx * tt, ry = aby * tt;
      var w = g.fl[i].w;
      var svx = w * ry;                 /* 尖端朝左的彈板：表面速度 = w·(ry, -rx) */
      var svy = w * (-rx);
      h = hitSegment(b, p.x, p.y, tip.x, tip.y, FLIP_R, 0.2, svx, svy);
      if (h && h.impact > 160) g.events.push({ type: 'flipHit', power: Math.min(1, h.impact / 1200) });
    }

    /* 幼幼班的彈力墊 */
    if (!d.drainOpen && b.y + b.r > geo.padY && b.vy > 0) {
      b.y = geo.padY - b.r;
      b.vy = -1050;
      b.vx *= 0.4;
      g.events.push({ type: 'pad' });
    }

    /* 彈跳墊 */
    for (n = 0; n < geo.bumpers.length; n++) {
      var bm = geo.bumpers[n];
      h = hitCircle(b, bm.x, bm.y, bm.r, 0.9);
      if (h) {
        var vn = b.vx * h.nx + b.vy * h.ny;
        if (vn < 600) { b.vx += (600 - vn) * h.nx; b.vy += (600 - vn) * h.ny; }
        if (g.bumperCd[n] <= 0) {
          g.bumperCd[n] = 0.12;
          g.bumperFlash[n] = 0.18;
          g.bumps++;
          g.score += 1;
          g.events.push({ type: 'bump', index: n });
        }
      }
    }

    /* 籃框的兩根框柱 */
    var hw = geo.hoop.w / 2;
    h = hitCircle(b, g.hoopX - hw, g.hoopY, 14, 0.5);      /* 前緣框柱；後面就是右牆（籃板） */
    if (h) {
      b.rim = true;
      if (h.impact > 90) g.events.push({ type: 'rim', power: Math.min(1, h.impact / 700) });
    }

    /* 進球判定：球心「相對於會上下移動的籃框」由上往下穿過框線，且在框柱與右牆之間。
       從籃框底下往上頂過框、球心連一顆球半徑都沒高過框線就掉回來（fromBelow）不算分；整顆球飛過框線之後再落下，就算正常投籃。 */
    var prevRel = prevY - g.prevHoopY, rel = b.y - g.hoopY;
    var inMouth = b.x > g.hoopX - hw + 4 && b.x < W;
    if (prevRel >= 0 && rel < 0 && inMouth) b.fromBelow = true;
    if (rel > 90 || rel < -BALL_R) b.fromBelow = false;     /* 球整顆飛過框線上方（或沉到框下很深），就算是新的一球 */
    var crossedDown = prevRel < 0 && rel >= 0 && inMouth;
    if (crossedDown && b.fromBelow) { b.fromBelow = false; crossedDown = false; }
    if (b.armed && crossedDown) {
      var swish = !b.rim;
      g.combo = (g.t - g.lastScoreT <= COMBO_WINDOW) ? Math.min(COMBO_MAX, g.combo + 1) : 1;
      if (g.combo > g.bestCombo) g.bestCombo = g.combo;
      var pts = (swish ? 30 : 20) * g.combo + (bonusActive(g.t) ? 10 : 0);
      g.score += pts;
      g.hoops++;
      if (swish) g.swishes++;
      g.lastScoreT = g.t;
      b.armed = false;
      b.rim = false;
      b.vy *= 0.55;
      b.vx *= 0.5;
      g.events.push({ type: 'score', points: pts, swish: swish, combo: g.combo });
    }
    if (!b.armed && b.y < g.hoopY - 90) b.armed = true;
    if (b.y > g.hoopY + 130) b.rim = false;

    /* 安全網：卡住或飛出界外 */
    if (b.x < -40 || b.x > W + 40 || b.y < -60) { b.x = W / 2; b.y = 300; b.vx = 0; b.vy = 0; }
    var speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (speed < 25 && b.y < 740) g.stuckT += dt; else g.stuckT = 0;
    if (g.stuckT > 2.5) {
      g.stuckT = 0;
      b.vx += (b.x < W / 2 ? 1 : -1) * 180;
      b.vy -= 220;
    }

    /* 漏球 */
    if (b.y > H + 40) {
      g.ball = null;
      g.events.push({ type: 'drain' });
      g.combo = 0;
      if (!g.unlimited && d.balls > 0 && g.ballNo >= d.balls) {
        g.overAt = g.t + 0.9;
      } else {
        g.respawnAt = g.t + 0.9;
      }
    }
  }

  /**
   * 推進遊戲。dtReal 是真實經過的秒數；input = { left, right }。
   * 回傳這次累積的事件（音效、特效用），呼叫端用完要自己清空。
   */
  function update(g, dtReal, input) {
    if (g.status !== 'playing') return;
    g.acc += Math.min(dtReal, 0.1);
    var inp = input || { left: false, right: false };
    while (g.acc >= STEP && g.status === 'playing') {
      g.acc -= STEP;
      step(g, inp);
      if (g.overAt && g.t >= g.overAt) { finish(g, 'balls'); break; }
      if (g.t >= g.diff.duration) { finish(g, 'time'); break; }
    }
  }

  function finish(g, reason) {
    g.status = 'over';
    g.overReason = reason;
    g.events.push({ type: 'over', reason: reason });
  }

  function timeLeft(g) {
    return Math.max(0, g.diff.duration - g.t);
  }

  /** 結算用的統計 */
  function summary(g) {
    return {
      difficulty: g.diff.id, score: g.score, hoops: g.hoops, swishes: g.swishes,
      bumps: g.bumps, bestCombo: g.bestCombo, seconds: Math.round(Math.min(g.t, g.diff.duration)),
      reason: g.overReason
    };
  }

  /** 畫面繪製用的精簡狀態 */
  function view(g) {
    return {
      diff: g.diff.id,
      ball: g.ball ? { x: g.ball.x, y: g.ball.y, spin: g.ball.spin } : null,
      fl: [g.fl[0].a],
      hx: g.hoopX, hy: g.hoopY,
      score: g.score, combo: g.combo, ballNo: g.ballNo, t: g.t,
      bonus: bonusActive(g.t),
      hint: !!(g.ball && !g.prevFlip &&
        g.ball.x < g.geo.pivots[0].x - g.geo.flipLen * 0.25 &&
        g.ball.x > g.geo.pivots[0].x - g.geo.flipLen * 0.8 &&
        g.ball.y > 700 && g.ball.y < 790 && g.ball.vy >= 0)
    };
  }

  var api = {
    W: W, H: H, STEP: STEP, BALL_R: BALL_R, REST: REST, ACTIVE: ACTIVE, FLIP_R: FLIP_R,
    COMBO_WINDOW: COMBO_WINDOW, COMBO_MAX: COMBO_MAX, bonusActive: bonusActive,
    DIFFS: DIFFS, DIFF_LIST: DIFF_LIST,
    geometry: geometry, flipperTip: flipperTip, hoopXAt: hoopXAt, hoopYAt: hoopYAt,
    create: create, update: update, step: step, timeLeft: timeLeft,
    summary: summary, view: view
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Rules = api;
})(typeof self !== 'undefined' ? self : this);
