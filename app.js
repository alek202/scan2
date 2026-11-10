'use strict';

var GS = String.fromCharCode(29);
var STORE = 'scanner.codes.v1';
var MODE_STORE = 'scanner.mode.v1';
var JOURNAL = 'scanner.journal.v1';

var el = function (id) { return document.getElementById(id); };
var video = el('video'), overlay = el('overlay'), statusEl = el('status');
var listEl = el('list'), countEl = el('count'), msgEl = el('msg');
var btnStart = el('btnStart'), btnTorch = el('btnTorch'), btnShow = el('btnShow');
var btnUndo = el('btnUndo'), btnClear = el('btnClear');

var codes = [];
var stream = null, track = null, detector = null, torchOn = false, scanning = false;
var lastSeen = {}, wakeLock = null, audio = null;
var viewIndex = 0, viewMode = 'dmA';

try { codes = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch (e) { codes = []; }
try { viewMode = localStorage.getItem(MODE_STORE) || 'dmA'; } catch (e) { viewMode = 'dmA'; }
if (viewMode === 'dm') viewMode = 'dmA';
if (['dmA','qr'].indexOf(viewMode) === -1) viewMode = 'dmA';

var journal = [];
try { journal = JSON.parse(localStorage.getItem(JOURNAL) || '[]'); } catch (e) { journal = []; }
(function pruneJournal() {
  var lim = Date.now() - 90 * 24 * 3600 * 1000;
  journal = journal.filter(function (j) { return j.t >= lim; });
})();
function saveJournal() { try { localStorage.setItem(JOURNAL, JSON.stringify(journal)); } catch (e) {} }

function save() { try { localStorage.setItem(STORE, JSON.stringify(codes)); } catch (e) {} }

// ---------- звук и вибрация ----------
function beep(kind) {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    var o = audio.createOscillator(), g = audio.createGain();
    var f = kind === 'ok' ? 1500 : kind === 'dup' ? 600 : 300;
    var d = kind === 'ok' ? 0.12 : kind === 'dup' ? 0.18 : 0.35;
    o.frequency.value = f; o.type = 'square'; g.gain.value = 0.25;
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + d);
  } catch (e) {}
  try { if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 60 : [80, 60, 80]); } catch (e) {}
}

// Крупная строка + мелкие пояснения (sub: строка или массив строк; предупреждения идут оранжевым)
function setStatus(text, cls, sub, warn) {
  statusEl.className = cls || '';
  statusEl.textContent = '';
  var big = document.createElement('div'); big.className = 'big'; big.textContent = text;
  statusEl.appendChild(big);
  (sub ? [].concat(sub) : []).forEach(function (t, i) {
    // элемент может быть строкой или объектом {t: текст, c: доп. класс}; name — строка наименования товара
    var extra = (t && typeof t === 'object') ? (' ' + t.c) : '';
    var d = document.createElement('div'); d.className = 'small' + (warn && i === 0 ? ' warn' : '') + extra;
    if (t && typeof t === 'object') {
      if (t.k) { var k = document.createElement('span'); k.className = 'kod'; k.textContent = t.k + ' '; d.appendChild(k); }
      d.appendChild(document.createTextNode(t.t));
    } else {
      d.textContent = t;
    }
    statusEl.appendChild(d);
  });
}
function fmtWhen(t) {
  var d = new Date(t);
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' в ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ---------- разбор кода ----------
function normalize(raw) {
  var s = String(raw || '').replace(/[\r\n]+$/g, '');
  s = s.replace(/^\][A-Za-z][0-9A-Za-z]/, '');  // префикс идентификатора символики, если есть
  s = s.replace(/^\x1d+/, '').replace(/\x1d+$/, '');  // GS в начале (FNC1) и в конце не храним
  if (/^\(01\)\d{14}\(21\)/.test(s)) s = fromHri(s);
  return s;
}
// Запасной распознаватель (iPhone) может вернуть текст со скобками: (01)GTIN(21)серия(91)..(92)..
// Собираем обратно «сырой» код: после серийного номера (21) перед каждой следующей частью ставим GS.
function fromHri(s) {
  var p = s.split(/\((\d{2,4})\)/);  // ['', '01', gtin, '21', serial, '91', x, ...]
  var out = '';
  for (var i = 1; i < p.length; i += 2) {
    if (i > 3) out += GS;
    out += p[i] + p[i + 1];
  }
  return out;
}
// Код маркировки Честного знака: 01 + GTIN(14) + 21 + серийный номер ...
function isMarking(s) { return /^01\d{14}21[\x21-\x7e]{3,}/.test(s); }

// ---------- список ----------
function render() {
  listEl.innerHTML = '';
  codes.forEach(function (c, i) {
    var li = document.createElement('li');
    var b = document.createElement('b'); b.textContent = (i + 1) + '.';
    var t = document.createElement('span');
    t.textContent = c.split(GS).join('␝');
    var box = document.createElement('div'); box.style.flex = '1';
    var p = productOf(c);
    if (p) {
      var nm = document.createElement('div'); nm.className = 'pname'; nm.textContent = (p.kod ? p.kod + ' ' : '') + p.name;
      box.appendChild(nm);
    }
    box.appendChild(t);
    li.appendChild(b); li.appendChild(box);
    listEl.appendChild(li);
  });
  var n = codes.length;
  countEl.textContent = n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? 'код' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'кода' : 'кодов'));
  btnShow.disabled = n === 0; btnUndo.disabled = n === 0; btnClear.disabled = n === 0;
  listEl.scrollTop = listEl.scrollHeight;
}

function addCode(raw) {
  var s = normalize(raw);
  var now = Date.now();
  if (lastSeen[s] && now - lastSeen[s] < 1500) { lastSeen[s] = now; return; }
  lastSeen[s] = now;
  if (!isMarking(s)) {
    beep('bad');
    setStatus('Это не код маркировки', 'bad', s.slice(0, 40).split(GS).join('\u241d'));
    return;
  }
  if (codes.indexOf(s) !== -1) {
    beep('dup');
    setStatus('Уже есть в списке (№' + (codes.indexOf(s) + 1) + ')', 'bad');
    return;
  }
  var prev = null;
  for (var k = journal.length - 1; k >= 0; k--) { if (journal[k].c === s) { prev = journal[k]; break; } }
  codes.push(s); save();
  var prod = productOf(s);
  journal.push({ t: Date.now(), c: s, n: prod ? prod.name : '' }); saveJournal();
  render(); beep('ok');
  var sub = [];
  if (prev) sub.push('Этот код уже сканировали: ' + fmtWhen(prev.t));
  sub.push(prod ? { t: prod.name, k: prod.kod, c: 'name' } : { t: 'Не найден в справочнике: GTIN ' + gtinOf(s), c: 'name' });
  sub.push(s.slice(0, 34).split(GS).join('\u241d'));
  setStatus('Принят № ' + codes.length, 'ok', sub, !!prev);
}

// ---------- камера и распознавание ----------
function drawBox(points) {
  var w = video.videoWidth, h = video.videoHeight;
  var cw = overlay.clientWidth, ch = overlay.clientHeight;
  overlay.width = cw; overlay.height = ch;
  var ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  if (!points || !points.length || !w || !h) return;
  // object-fit: cover
  var sc = Math.max(cw / w, ch / h);
  var ox = (cw - w * sc) / 2, oy = (ch - h * sc) / 2;
  ctx.lineWidth = 4; ctx.strokeStyle = '#2ecc71'; ctx.beginPath();
  points.forEach(function (p, i) {
    var x = p.x * sc + ox, y = p.y * sc + oy;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath(); ctx.stroke();
}

function loop() {
  if (!scanning) return;
  if (video.readyState >= 2) {
    detector.detect(video).then(function (found) {
      if (found.length) {
        drawBox(found[0].cornerPoints);
        found.forEach(function (f) { addCode(f.rawValue); });
      } else {
        drawBox(null);
      }
    }).catch(function () {}).then(function () { setTimeout(loop, 90); });
  } else {
    setTimeout(loop, 150);
  }
}

// Встроенный распознаватель Chrome (Android); если его нет (iPhone) — запасной на WebAssembly из папки сайта
function makeDetector() {
  var fmts = ['data_matrix', 'qr_code'];
  var native = Promise.resolve(false);
  if ('BarcodeDetector' in window) {
    native = BarcodeDetector.getSupportedFormats().then(function (sup) {
      return sup.indexOf('data_matrix') !== -1 && sup.indexOf('qr_code') !== -1;
    }).catch(function () { return false; });
  }
  return native.then(function (ok) {
    if (ok) return new BarcodeDetector({ formats: fmts });
    var API = window.BarcodeDetectionAPI;
    if (!API) throw new Error('распознаватель не загружен');
    API.prepareZXingModule({
      overrides: { locateFile: function (path, prefix) { return path.slice(-5) === '.wasm' ? 'zxing_reader.wasm' : prefix + path; } },
      fireImmediately: true
    });
    return new API.BarcodeDetector({ formats: fmts });
  });
}

function startCamera() {
  makeDetector().then(function (d) {
    detector = d;
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
  }).then(function (s) {
    if (!s) return;
    stream = s; track = s.getVideoTracks()[0];
    video.srcObject = s; return video.play();
  }).then(function () {
    if (!stream) return;
    el('start').style.display = 'none';
    try {
      var cap = track.getCapabilities ? track.getCapabilities() : {};
      var adv = [];
      if (cap.focusMode && cap.focusMode.indexOf('continuous') !== -1) adv.push({ focusMode: 'continuous' });
      if (adv.length) track.applyConstraints({ advanced: adv });
      btnTorch.disabled = !cap.torch;
      if (!cap.torch) btnTorch.style.display = 'none';
    } catch (e) { btnTorch.style.display = 'none'; }
    scanning = true; setStatus('Наведите камеру на код'); keepAwake(); loop();
  }).catch(function (e) {
    msgEl.textContent = 'Камера не включилась: ' + (e && e.message ? e.message : e);
  });
}

function toggleTorch() {
  if (!track) return;
  torchOn = !torchOn;
  track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(function () { torchOn = !torchOn; });
}

function keepAwake() {
  try {
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
  } catch (e) {}
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && (scanning || el('viewer').classList.contains('on'))) keepAwake();
});

// ---------- показ кодов ----------
var MODES = ['dmA', 'qr'];
var MODE_NAMES = { dmA: 'Data Matrix', qr: 'QR' };

function esc(t) { return t.replace(/\^/g, '^094'); }

function drawCode() {
  var c = codes[viewIndex];
  var next = MODES[(MODES.indexOf(viewMode) + 1) % MODES.length];
  el('vinfo').textContent = (viewIndex + 1) + ' из ' + codes.length + '  (' + MODE_NAMES[viewMode] + ')';
  var vp = productOf(c);
  el('vname').textContent = vp ? vp.name : '';
  el('vtxt').textContent = c.split(GS).join('\u241d');
  el('vPrev').disabled = viewIndex === 0;
  el('vNext').disabled = viewIndex >= codes.length - 1;
  el('vMode').textContent = MODE_NAMES[next];
  var cv = el('vcode');
  var base = { scale: 6, padding: 10, backgroundcolor: 'FFFFFF' };
  var o;
  try {
    if (viewMode === 'dmA') {
      // GS1 DataMatrix: FNC1 в начале и FNC1 вместо разделителя GS
      o = { bcid: 'datamatrix', text: '^FNC1' + esc(c).split(GS).join('^FNC1'), parsefnc: true };
    } else {
      o = { bcid: 'qrcode', text: c, eclevel: 'M' };
    }
    Object.keys(base).forEach(function (k) { o[k] = base[k]; });
    bwipjs.toCanvas(cv, o);
  } catch (e) {
    cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    el('vtxt').textContent = 'Ошибка рисования: ' + e;
  }
}

function openViewer() {
  if (!codes.length) return;
  viewIndex = 0; el('viewer').classList.add('on'); keepAwake(); drawCode();
}

btnStart.addEventListener('click', function () { beep('dup'); startCamera(); });
btnTorch.addEventListener('click', toggleTorch);
btnShow.addEventListener('click', openViewer);
btnUndo.addEventListener('click', function () {
  var last = codes.pop(); save();
  for (var i = journal.length - 1; i >= 0; i--) { if (journal[i].c === last) { journal.splice(i, 1); break; } }
  saveJournal(); render();
});
btnClear.addEventListener('click', function () {
  if (confirm('Удалить все ' + codes.length + ' кодов из списка?')) { codes = []; save(); render(); }
});
el('vPrev').addEventListener('click', function () { if (viewIndex > 0) { viewIndex--; drawCode(); } });
el('vNext').addEventListener('click', function () { if (viewIndex < codes.length - 1) { viewIndex++; drawCode(); } });
el('vMode').addEventListener('click', function () {
  viewMode = MODES[(MODES.indexOf(viewMode) + 1) % MODES.length];
  try { localStorage.setItem(MODE_STORE, viewMode); } catch (e) {}
  drawCode();
});
el('vClose').addEventListener('click', function () { el('viewer').classList.remove('on'); });

render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(function () {});
}

// ---------- журнал за день ----------
function pad(n) { return (n < 10 ? '0' : '') + n; }
function dayKey(t) { var d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function dayEntries(key) { return journal.filter(function (j) { return dayKey(j.t) === key; }); }

function updateJournalInfo() {
  var key = el('jDate').value;
  var n = key ? dayEntries(key).length : 0;
  el('jInfo').textContent = key ? ('Кодов за этот день: ' + n) : 'Выберите дату';
  el('jShare').disabled = n === 0; el('jSave').disabled = n === 0;
}

function buildCsv(key) {
  var rows = ['Дата;Время;№;Код (разделители показаны как ␝);Код (как есть, с разделителями GS);Наименование'];
  dayEntries(key).forEach(function (j, i) {
    var d = new Date(j.t);
    var tm = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    var vis = j.c.split(GS).join('\u241d');
    var pn = j.n || (productOf(j.c) ? productOf(j.c).name : '');
    rows.push([key, tm, i + 1, '"' + vis.replace(/"/g, '""') + '"', '"' + j.c.replace(/"/g, '""') + '"', '"' + pn.replace(/"/g, '""') + '"'].join(';'));
  });
  return '\ufeff' + rows.join('\r\n') + '\r\n';
}

function makeFile(key) {
  var name = 'коды-' + key + '.csv';
  var blob = new Blob([buildCsv(key)], { type: 'text/csv;charset=utf-8' });
  return { name: name, blob: blob };
}

function saveFile() {
  var f = makeFile(el('jDate').value);
  var u = URL.createObjectURL(f.blob);
  var a = document.createElement('a');
  a.href = u; a.download = f.name; document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(u); a.remove(); }, 1000);
  el('jInfo').textContent = 'Файл сохранён в «Загрузки»: ' + f.name;
}

function shareFile() {
  var f = makeFile(el('jDate').value);
  var file = new File([f.blob], f.name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: f.name }).catch(function () {});
  } else {
    saveFile();
  }
}

el('btnJournal').addEventListener('click', function () {
  el('jDate').value = dayKey(Date.now());
  updateJournalInfo(); el('jrn').classList.add('on');
});
el('jDate').addEventListener('change', updateJournalInfo);
el('jShare').addEventListener('click', shareFile);
el('jSave').addEventListener('click', saveFile);
el('jClose').addEventListener('click', function () { el('jrn').classList.remove('on'); });

// ---------- отправка заказа на кассу (очередь на сервере) ----------
var CFG = 'scanner.cfg.v1', ORDER = 'scanner.order.v1';
var cfg = { url: 'https://194-190-153-224.sslip.io:8444', token: '', seller: '' }, order = null, pollTimer = null;
var btnSend = el('btnSend');
try { cfg = Object.assign(cfg, JSON.parse(localStorage.getItem(CFG) || '{}')); } catch (e) {}
try { order = JSON.parse(localStorage.getItem(ORDER) || 'null'); } catch (e) { order = null; }
function saveOrder() { try { localStorage.setItem(ORDER, JSON.stringify(order)); } catch (e) {} }

function orderLine(text, cls) { var o = el('orderInfo'); o.textContent = text; o.className = cls || ''; }

function showOrder() {
  btnSend.disabled = codes.length === 0;
  if (!order) { orderLine(codes.length ? 'Не отправлено на кассу' : '', codes.length ? 'wait' : ''); return; }
  if (order.status === 'cancelled') { orderLine('Заказ № ' + order.id + ' отменён', 'bad'); return; }
  if (order.status === 'acked') orderLine('Заказ № ' + order.id + ': принят кассой (' + order.count + ' шт.)', 'ok');
  else orderLine('Заказ № ' + order.id + ': передан, ждёт кассу (' + order.count + ' шт.)', 'wait');
}

function api(method, path, body) {
  var opts = { method: method, headers: { 'X-Auth-Token': cfg.token } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch(cfg.url.replace(/\/+$/, '') + path, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) { var err = new Error(j.error || ('HTTP ' + r.status)); err.status = r.status; throw err; }
      return j;
    });
  });
}

function poll() {
  clearTimeout(pollTimer);
  if (!order || order.status === 'acked' || !cfg.url) return;
  api('GET', '/api/orders/' + order.id).then(function (j) {
    if (j.status === 'acked') { order.status = 'acked'; saveOrder(); showOrder(); beep('ok'); return; }
    if (j.status === 'cancelled') { order.status = 'cancelled'; saveOrder(); showOrder(); return; }
    pollTimer = setTimeout(poll, 5000);
  }).catch(function () { pollTimer = setTimeout(poll, 10000); });
}

function sendOrder() {
  if (!cfg.url || !cfg.token) { openCfg(); return; }
  if (!codes.length) return;
  var sig = codes.join('\n');
  // тот же список уже передан или принят кассой — повторно не отправляем
  if (order && order.sig === sig && order.status !== 'cancelled') {
    beep('dup');
    orderLine(order.status === 'acked'
      ? 'Этот список уже принят кассой (заказ № ' + order.id + '). Для новых канистр нажмите «Новый заказ».'
      : 'Уже передано: заказ № ' + order.id + ', ждёт кассу.', 'wait');
    return;
  }
  // заказ уже принят кассой — дополнять его нельзя
  if (order && order.status === 'acked') {
    beep('bad');
    orderLine('Заказ № ' + order.id + ' уже принят кассой. Для новых канистр нажмите «Новый заказ».', 'bad');
    return;
  }
  // заказ передан, но не принят, а список изменился — предлагаем заменить
  var replace = order && order.status === 'new';
  if (replace && !confirm('Заказ № ' + order.id + ' ещё не принят кассой. Заменить его новым списком из ' + codes.length + ' кодов?')) return;
  btnSend.disabled = true; orderLine('Отправляю…', 'wait');
  var prev = replace ? api('POST', '/api/orders/' + order.id + '/cancel').catch(function (e) {
    if (e && e.status === 409) throw new Error('старый заказ № ' + order.id + ' уже принят кассой, обновите страницу');
    throw e;
  }) : Promise.resolve();
  prev.then(function () {
    return api('POST', '/api/orders', { seller: cfg.seller, codes: codes });
  }).then(function (j) {
    order = { id: j.id, status: 'new', count: j.count || codes.length, sig: sig };
    saveOrder(); showOrder(); beep('ok'); poll();
  }).catch(function (e) {
    btnSend.disabled = false;
    orderLine('Не отправлено: ' + (e && e.message ? e.message : e) + '. Список сохранён, можно повторить.', 'bad');
    beep('bad');
  });
}

function newOrder() {
  if (codes.length && (!order || order.status !== 'acked')) {
    if (!confirm('Список не принят кассой. Всё равно начать новый заказ и очистить список?')) return;
  }
  codes = []; save(); order = null; saveOrder(); render(); showOrder();
}

function openCfg() {
  el('cUrl').value = cfg.url; el('cToken').value = cfg.token; el('cSeller').value = cfg.seller;
  catInfo(); el('cfgm').classList.add('on');
}
el('btnSend').addEventListener('click', sendOrder);
el('btnNew').addEventListener('click', newOrder);
el('btnCfg').addEventListener('click', openCfg);
el('cClose').addEventListener('click', function () { el('cfgm').classList.remove('on'); });
el('cSave').addEventListener('click', function () {
  cfg = { url: el('cUrl').value.trim(), token: el('cToken').value.trim(), seller: el('cSeller').value.trim() };
  try { localStorage.setItem(CFG, JSON.stringify(cfg)); } catch (e) {}
  el('cfgm').classList.remove('on'); showOrder(); poll();
});

// обновляем строку заказа при любом изменении списка
var _render = render;
render = function () { _render(); showOrder(); };
render();
poll();

// ---------- справочник товаров: GTIN -> наименование (файл из 1С8, хранится в телефоне) ----------
var CAT = 'scanner.cat.v1';
var catalog = null;  // { k: { "<GTIN без ведущих нулей>": [код, наименование] }, n: число, t: время загрузки }
try { catalog = JSON.parse(localStorage.getItem(CAT) || 'null'); } catch (e) { catalog = null; }

function gtinOf(code) { var m = /^01(\d{14})/.exec(code || ''); return m ? m[1] : ''; }
function productOf(code) {
  var g = gtinOf(code);
  if (!g || !catalog || !catalog.k) return null;
  var r = catalog.k[g.replace(/^0+/, '')];
  if (!r) return null;
  // у штрихкода может быть несколько позиций: r = [код, наименование] или [[код, наименование], ...]
  var list = (typeof r[0] === 'string') ? [r] : r;
  if (list.length === 1) return { kod: list[0][0], name: list[0][1] };
  return {
    kod: list.map(function (x) { return x[0]; }).join(', '),
    name: 'Варианты (' + list.length + '): ' + list.map(function (x) { return x[1]; }).join(' / ')
  };
}

function decodeBytes(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) { return new TextDecoder('windows-1251').decode(buf); }
}

function splitLine(line, d) {
  var out = [], cur = '', q = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === d) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCatalog(text) {
  var lines = text.replace(/^\ufeff/, '').split(/\r?\n/).filter(function (l) { return l.trim(); });
  if (!lines.length) throw new Error('файл пустой');
  var first = lines[0], best = ';', bc = -1;
  [';', '\t', ','].forEach(function (d) { var c = first.split(d).length; if (c > bc) { bc = c; best = d; } });
  var k = {}, n = 0;
  lines.forEach(function (l) {
    var f = splitLine(l, best);
    var bar = (f[0] || '').replace(/\D/g, '');
    if (bar.length < 8) return;  // заголовок или мусор
    var name = f.slice(2).join(best).trim();
    if (!name) return;
    var key = bar.replace(/^0+/, '');
    var kod = (f[1] || '').trim();
    if (!k[key]) { k[key] = [[kod, name]]; n++; return; }
    var dup = k[key].some(function (x) { return x[0] === kod; });
    if (!dup) k[key].push([kod, name]);
  });
  if (!n) throw new Error('не нашёл ни одной строки вида «штрихкод; код; наименование»');
  return { k: k, n: n, t: Date.now() };
}

function catInfo() {
  var i = el('cCatInfo');
  if (!i) return;
  i.textContent = catalog ? ('В справочнике ' + catalog.n + ' товаров, загружен ' + fmtWhen(catalog.t)) : 'Справочник не загружен';
}

el('cCat').addEventListener('change', function () {
  var f = this.files && this.files[0];
  if (!f) return;
  var rd = new FileReader();
  rd.onload = function () {
    try {
      var c = parseCatalog(decodeBytes(rd.result));
      localStorage.setItem(CAT, JSON.stringify(c));
      catalog = c; catInfo(); render();
      el('cCatInfo').textContent += '. Готово.';
    } catch (e) {
      el('cCatInfo').textContent = 'Не загрузилось: ' + (e && e.message ? e.message : e);
    }
  };
  rd.readAsArrayBuffer(f);
});
catInfo();
render();
