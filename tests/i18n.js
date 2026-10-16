/* ===== tests/i18n.js — 字典完整性：zh-Hant 與 en 的 key 集合必須一致，且程式用到的 key 都存在 ===== */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dicts = {};
global.I18N = { register(code, d) { dicts[code] = Object.assign(dicts[code] || {}, d); return global.I18N; } };
const pub = path.join(__dirname, '..', 'public');
new Function(fs.readFileSync(path.join(pub, 'js', 'locales.js'), 'utf8'))();

const zh = Object.keys(dicts['zh-Hant']), en = Object.keys(dicts.en);
const missingEn = zh.filter(k => !(k in dicts.en)), missingZh = en.filter(k => !(k in dicts['zh-Hant']));
assert.deepStrictEqual(missingEn, [], '英文缺 key：' + missingEn.join(', '));
assert.deepStrictEqual(missingZh, [], '中文缺 key：' + missingZh.join(', '));
en.forEach(k => assert(String(dicts.en[k]) !== '', '英文空字串：' + k));

/* 程式與 HTML 用到的靜態 key 都要存在 */
const src = fs.readFileSync(path.join(pub, 'index.html'), 'utf8') + fs.readFileSync(path.join(pub, 'js', 'app.js'), 'utf8');
const used = new Set();
for (const m of src.matchAll(/data-i18n(?:-html)?="([\w.-]+)"/g)) used.add(m[1]);
for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) m[1].split(';').forEach(p => used.add(p.split('=')[1]));
for (const m of src.matchAll(/\bT\('([\w.-]+)'/g)) { if (!m[1].endsWith('.')) used.add(m[1]); }
const bad = [...used].filter(k => !(k in dicts['zh-Hant']));
assert.deepStrictEqual(bad, [], '未定義的 key：' + bad.join(', '));
console.log('i18n 字典完整：' + zh.length + ' 個 key');
