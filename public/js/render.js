/* ===== render.js — Canvas 繪圖：夜間街頭球場 ＋ 霓虹燈管 =====
 *
 * 美術方向（簡述）
 *   配色：瀝青深藍底 #0d1224、籃球橘 #ff7a1a、霓虹青 #22e4ff、霓虹洋紅 #ff3d9a、螢光黃 #ffe14d
 *   形狀：球場畫線、燈管牆、膠帶包覆的彈板；彈跳墊是亮環＋星形，跟球形狀明顯不同
 *   材質：瀝青噪點＋橘色漆線，邊界為發光燈管；所有圖形都用向量繪製，沒有 emoji 文字
 *   動態：球有轉動與拖尾、彈跳墊閃光、進球時籃框爆光與數字彈出（可在設定中關閉）
 */
(function (root) {
  'use strict';

  var Rules = root.Rules;
  var W = 600, H = 900;

  var C = {
    bg1: '#0b1020', bg2: '#171d38', orange: '#ff7a1a', orangeDark: '#b84a05',
    cyan: '#22e4ff', magenta: '#ff3d9a', yellow: '#ffe14d', white: '#f4f7ff'
  };

  function create(canvas) {
    var ctx = canvas.getContext('2d');
    var r = {
      canvas: canvas, ctx: ctx, cssW: 300, cssH: 450, dpr: 1, scale: 0.5,
      bg: null, bgKey: '',
      trail: [], parts: [], pops: [], shakeT: 0, shakeAmp: 0, glow: 0,
      lastDraw: 0, netSway: 0, lastHx: 300
    };

    r.resize = function (cssW, cssH, dpr) {
      r.cssW = cssW; r.cssH = cssH; r.dpr = dpr || 1;
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      canvas.width = Math.max(1, Math.round(cssW * r.dpr));
      canvas.height = Math.max(1, Math.round(cssH * r.dpr));
      r.scale = cssW / W;
      r.bg = null;
    };

    r.spark = function (x, y, color, n) {
      for (var i = 0; i < (n || 8); i++) {
        var a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 220;
        r.parts.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: 0.5 + Math.random() * 0.3, max: 0.8, c: color });
      }
    };
    r.pop = function (x, y, text, color) {
      r.pops.push({ x: x, y: y, text: text, c: color || C.yellow, life: 1.0 });
    };
    r.shake = function (amp) { r.shakeT = 0.18; r.shakeAmp = amp; };
    r.flash = function () { r.glow = 1; };
    r.reset = function () { r.trail.length = 0; r.parts.length = 0; r.pops.length = 0; r.glow = 0; };

    /* ----- 背景（快取） ----- */
    function paintBackground(geo, opts) {
      var cv = document.createElement('canvas');
      cv.width = canvas.width; cv.height = canvas.height;
      var g = cv.getContext('2d');
      var k = r.dpr * r.scale;
      g.setTransform(k, 0, 0, k, 0, 0);

      var grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, C.bg1); grad.addColorStop(1, C.bg2);
      g.fillStyle = grad; g.fillRect(0, 0, W, H);

      /* 瀝青噪點：固定種子的小點 */
      var seed = 12345;
      function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
      g.fillStyle = 'rgba(255,255,255,0.035)';
      for (var i = 0; i < 380; i++) g.fillRect(rnd() * W, rnd() * H, 2, 2);
      g.fillStyle = 'rgba(0,0,0,0.12)';
      for (i = 0; i < 240; i++) g.fillRect(rnd() * W, rnd() * H, 3, 2);

      /* 球場漆線：籃框在右牆，三分線與禁區以右牆為中心 */
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(255,122,26,0.34)';
      g.beginPath(); g.arc(W, 260, 400, 0.62 * Math.PI, 1.38 * Math.PI); g.stroke();
      g.strokeStyle = 'rgba(34,228,255,0.22)';
      g.strokeRect(W - 250, 150, 250, 220);
      g.beginPath(); g.arc(W - 250, 260, 90, 0.5 * Math.PI, 1.5 * Math.PI); g.stroke();
      g.strokeStyle = 'rgba(255,122,26,0.22)';
      g.beginPath(); g.arc(300, 640, 120, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(0, 640); g.lineTo(W, 640); g.stroke();

      /* 場地字樣 */
      g.save();
      g.translate(W / 2, 640); g.rotate(-0.04);
      g.font = '900 64px "Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = 'rgba(255,225,77,0.10)';
      g.fillText('彈珠籃球', 0, 0);
      g.restore();

      /* 漏球口（彈板尖端左邊）的警示斜紋；幼幼班改成彈力墊 */
      var tipRest = Rules.flipperTip(geo, 0, Rules.REST);
      if (geo.diff.drainOpen) {
        g.save();
        g.beginPath(); g.rect(6, 845, Math.max(10, tipRest.x - 24), 55); g.clip();
        g.strokeStyle = 'rgba(255,61,154,0.35)'; g.lineWidth = 6;
        for (var x = -40; x < tipRest.x + 40; x += 16) { g.beginPath(); g.moveTo(x, 900); g.lineTo(x + 40, 845); g.stroke(); }
        g.restore();
      } else {
        g.fillStyle = 'rgba(34,228,255,0.28)';
        g.fillRect(6, geo.padY - 4, tipRest.x, 10);
      }

      /* 燈管牆 */
      g.lineCap = 'round';
      geo.segs.forEach(function (s, idx) {
        var col = s.ax < 300 && s.bx < 300 ? C.magenta : (s.ax >= 300 && s.bx >= 300 ? C.cyan : C.yellow);
        if (s.ay === 0 && s.by === 0) col = C.orange;
        tube(g, s.ax, s.ay, s.bx, s.by, col, opts.contrast);
      });

      r.bg = cv;
    }

    function tube(g, ax, ay, bx, by, col, strong) {
      g.save();
      g.lineCap = 'round';
      g.strokeStyle = col; g.globalAlpha = 0.18; g.lineWidth = 16;
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      g.globalAlpha = 0.45; g.lineWidth = strong ? 9 : 8;
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      g.globalAlpha = 1; g.lineWidth = 3;
      g.strokeStyle = '#ffffff';
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      g.restore();
    }

    /* ----- 元件 ----- */
    function drawBall(g, x, y, spin, opts) {
      var R = Rules.BALL_R;
      g.save();
      g.translate(x, y);
      g.shadowColor = 'rgba(255,122,26,0.9)'; g.shadowBlur = 16;
      var gr = g.createRadialGradient(-R * 0.35, -R * 0.4, 2, 0, 0, R * 1.1);
      gr.addColorStop(0, '#ffb36b'); gr.addColorStop(0.55, C.orange); gr.addColorStop(1, C.orangeDark);
      g.fillStyle = gr;
      g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
      g.rotate(spin);
      g.strokeStyle = '#2a1204'; g.lineWidth = 1.8;
      g.beginPath(); g.moveTo(-R, 0); g.lineTo(R, 0); g.moveTo(0, -R); g.lineTo(0, R); g.stroke();
      g.beginPath(); g.arc(-R * 1.25, 0, R * 0.95, -0.95, 0.95); g.stroke();
      g.beginPath(); g.arc(R * 1.25, 0, R * 0.95, Math.PI - 0.95, Math.PI + 0.95); g.stroke();
      g.rotate(-spin);
      g.strokeStyle = opts.contrast ? '#ffffff' : 'rgba(255,255,255,0.35)';
      g.lineWidth = opts.contrast ? 2.5 : 1.2;
      g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.stroke();
      g.restore();
    }

    function drawBumper(g, b, idx, flash, opts) {
      var cols = [C.cyan, C.magenta, C.yellow];
      var col = cols[idx % 3];
      var k = 1 + (flash > 0 ? flash * 1.4 : 0);
      g.save();
      g.translate(b.x, b.y);
      g.scale(k, k);
      g.shadowColor = col; g.shadowBlur = flash > 0 ? 34 : 14;
      g.fillStyle = '#0a0f20';
      g.beginPath(); g.arc(0, 0, b.r, 0, Math.PI * 2); g.fill();
      g.lineWidth = opts.contrast ? 7 : 5; g.strokeStyle = col;
      g.beginPath(); g.arc(0, 0, b.r - 2, 0, Math.PI * 2); g.stroke();
      g.shadowBlur = 0;
      g.fillStyle = flash > 0 ? '#ffffff' : col;
      g.globalAlpha = flash > 0 ? 1 : 0.85;
      star(g, 0, 0, b.r * 0.55, b.r * 0.24, 5);
      g.fill();
      g.restore();
    }

    function star(g, x, y, ro, ri, n) {
      g.beginPath();
      for (var i = 0; i < n * 2; i++) {
        var a = -Math.PI / 2 + i * Math.PI / n, rad = i % 2 ? ri : ro;
        var px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
        if (i) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.closePath();
    }

    function drawFlipper(g, geo, i, a, pressed, opts) {
      var p = geo.pivots[i], t = Rules.flipperTip(geo, i, a);
      g.save();
      g.lineCap = 'round';
      g.strokeStyle = '#05070f'; g.lineWidth = Rules.FLIP_R * 2 + 5;
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(t.x, t.y); g.stroke();
      var gr = g.createLinearGradient(p.x, p.y, t.x, t.y);
      gr.addColorStop(0, C.orangeDark); gr.addColorStop(1, pressed ? '#ffd27a' : C.orange);
      g.strokeStyle = gr; g.lineWidth = Rules.FLIP_R * 2 - 1;
      if (pressed) { g.shadowColor = C.orange; g.shadowBlur = 22; }
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(t.x, t.y); g.stroke();
      g.shadowBlur = 0;
      g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 3;
      var ox = (t.y - p.y), oy = -(t.x - p.x), ol = Math.sqrt(ox * ox + oy * oy) || 1;
      ox = ox / ol * 3; oy = oy / ol * 3;
      g.beginPath(); g.moveTo(p.x + (t.x - p.x) * 0.18 + ox, p.y + (t.y - p.y) * 0.18 + oy);
      g.lineTo(p.x + (t.x - p.x) * 0.92 + ox, p.y + (t.y - p.y) * 0.92 + oy); g.stroke();
      g.fillStyle = '#0a0f20'; g.strokeStyle = opts.contrast ? '#fff' : C.cyan; g.lineWidth = 3;
      g.beginPath(); g.arc(p.x, p.y, 7, 0, Math.PI * 2); g.fill(); g.stroke();
      g.restore();
    }

    /* 籃框貼在右牆、開口朝左：籃板在最右，框往左伸，球網往下垂 */
    function drawHoopBack(g, geo, hx, hy) {
      var w = geo.hoop.w, hw = w / 2;
      g.save();
      g.fillStyle = 'rgba(244,247,255,0.14)';
      g.strokeStyle = 'rgba(244,247,255,0.9)'; g.lineWidth = 3;
      g.beginPath(); g.rect(W - 14, hy - 86, 12, 120); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(255,122,26,0.95)';
      g.strokeRect(W - 13, hy - 46, 10, 40);
      g.restore();
      var sw = r.netSway;
      g.save();
      g.strokeStyle = 'rgba(244,247,255,0.7)'; g.lineWidth = 1.6;
      var depth = 46, n = 6;
      for (var i = 0; i <= n; i++) {
        var u = i / n;
        var x0 = hx - hw + u * w, x1 = hx - hw * 0.6 + u * w * 0.6 + sw * 0.5;
        g.beginPath(); g.moveTo(x0, hy); g.lineTo(x1, hy + depth); g.stroke();
      }
      for (var j = 1; j <= 3; j++) {
        var v = j / 3.4, yy = hy + depth * v;
        g.beginPath(); g.moveTo(hx - hw + hw * 0.4 * v + sw * 0.5 * v, yy); g.lineTo(hx + hw - hw * 0.4 * v + sw * 0.5 * v, yy); g.stroke();
      }
      g.restore();
    }

    function drawHoopFront(g, geo, hx, hy, glow, opts) {
      var w = geo.hoop.w;
      g.save();
      if (glow > 0) { g.shadowColor = C.yellow; g.shadowBlur = 40 * glow; }
      g.lineCap = 'round';
      g.strokeStyle = C.orange; g.lineWidth = opts.contrast ? 8 : 6;
      g.beginPath(); g.moveTo(hx - w / 2, hy); g.lineTo(hx + w / 2, hy); g.stroke();
      g.shadowBlur = 0;
      g.fillStyle = '#ffd9b0';
      g.beginPath(); g.arc(hx - w / 2, hy, 6, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(hx + w / 2, hy, 6, 0, Math.PI * 2); g.fill();
      g.restore();
    }

    /* ----- 主繪製 ----- */
    r.draw = function (view, opts) {
      opts = opts || {};
      var geo = Rules.geometry(view.diff);
      var key = view.diff + '|' + r.canvas.width + 'x' + r.canvas.height + '|' + (opts.contrast ? 1 : 0);
      if (!r.bg || r.bgKey !== key) { paintBackground(geo, opts); r.bgKey = key; }

      var now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
      var dt = r.lastDraw ? Math.min(0.05, now - r.lastDraw) : 0.016;
      r.lastDraw = now;

      var g = ctx, k = r.dpr * r.scale;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.drawImage(r.bg, 0, 0);

      var sx = 0, sy = 0;
      if (!opts.reduceMotion && r.shakeT > 0) {
        r.shakeT -= dt;
        sx = (Math.random() - 0.5) * r.shakeAmp; sy = (Math.random() - 0.5) * r.shakeAmp;
      }
      g.setTransform(k, 0, 0, k, sx * k, sy * k);

      /* 籃框移動量 → 球網擺動 */
      var hx = view.hx, hy = view.hy;
      r.netSway += ((hy - r.lastHx) * -0.6 - r.netSway) * 0.2;
      r.lastHx = hy;
      if (r.glow > 0) r.glow = Math.max(0, r.glow - dt * 2.2);

      drawHoopBack(g, geo, hx, hy);

      geo.bumpers.forEach(function (b, i) {
        drawBumper(g, b, i, (opts.bumperFlash && opts.bumperFlash[i]) || 0, opts);
      });

      var pressed = opts.pressed || [false];
      drawFlipper(g, geo, 0, view.fl[0], pressed[0], opts);

      /* 球與拖尾 */
      if (view.ball) {
        if (!opts.reduceMotion) {
          r.trail.push({ x: view.ball.x, y: view.ball.y });
          if (r.trail.length > 9) r.trail.shift();
          for (var i = 0; i < r.trail.length - 1; i++) {
            var a = (i + 1) / r.trail.length;
            g.fillStyle = 'rgba(255,122,26,' + (0.28 * a).toFixed(3) + ')';
            g.beginPath(); g.arc(r.trail[i].x, r.trail[i].y, Rules.BALL_R * (0.45 + 0.5 * a), 0, Math.PI * 2); g.fill();
          }
        }
        drawBall(g, view.ball.x, view.ball.y, view.ball.spin || 0, opts);
      } else {
        r.trail.length = 0;
      }

      drawHoopFront(g, geo, hx, hy, r.glow, opts);

      /* 粒子與分數彈出 */
      if (!opts.reduceMotion) {
        for (var p = r.parts.length - 1; p >= 0; p--) {
          var q = r.parts[p];
          q.life -= dt;
          if (q.life <= 0) { r.parts.splice(p, 1); continue; }
          q.vy += 500 * dt; q.x += q.vx * dt; q.y += q.vy * dt;
          g.globalAlpha = Math.max(0, q.life / q.max);
          g.fillStyle = q.c;
          g.fillRect(q.x - 2, q.y - 2, 4, 4);
        }
        g.globalAlpha = 1;
      } else {
        r.parts.length = 0;
      }
      for (var m = r.pops.length - 1; m >= 0; m--) {
        var o = r.pops[m];
        o.life -= dt * (opts.reduceMotion ? 0.8 : 1);
        if (o.life <= 0) { r.pops.splice(m, 1); continue; }
        var rise = opts.reduceMotion ? 0 : (1 - o.life) * 46;
        g.globalAlpha = Math.min(1, o.life * 1.8);
        g.font = '900 34px "Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.lineWidth = 6; g.strokeStyle = 'rgba(5,7,15,0.9)';
        g.strokeText(o.text, o.x, o.y - rise);
        g.fillStyle = o.c;
        g.fillText(o.text, o.x, o.y - rise);
      }
      g.globalAlpha = 1;
    };

    return r;
  }

  root.Render = { create: create, COLORS: C };
})(typeof self !== 'undefined' ? self : this);
