/* ===== 本機靜態檔案伺服器：只監聽 loopback，不提供遊戲連線服務 ===== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = 3200;
const ROOT = path.resolve(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://' + HOST).pathname);
  } catch (error) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const relativePath = pathname.replace(/^\/+/, '') || 'index.html';
  let file = path.resolve(ROOT, relativePath);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(file, (statError, stat) => {
    if (!statError && stat.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (readError, body) => {
      if (readError) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log('彈珠籃球本機頁面：http://' + HOST + ':' + PORT);
});
