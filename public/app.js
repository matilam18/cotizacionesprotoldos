/* Cotizador ProToldos — interfaz */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clp = (n) => '$' + Math.round(n || 0).toLocaleString('es-CL');
const numv = (v) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const pad4 = (n) => String(n).padStart(4, '0');
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}-${m}-${y}`; };
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + Number(n || 0)); return d.toISOString().slice(0, 10); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------- API ----------------
async function api(method, path, body, raw) {
  const opt = { method, headers: { 'X-Cotizador': '1' }, credentials: 'same-origin' };
  if (raw) { opt.body = raw; opt.headers['Content-Type'] = 'application/pdf'; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch('/api' + path, opt); }
  catch { throw new Error('Sin conexión. Revisa internet e intenta de nuevo.'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !['/login', '/setup', '/pin'].includes(path)) { showAuth(); throw new Error(data.error || 'Sesión expirada.'); }
  if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
  return data;
}

let toastT;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('bad', !!bad); t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---------------- estado ----------------
let settings = {};
let logoMeta = null;           // {data, w, h, fmt}
const st = {
  id: null, number: null, items: [], img: null, discType: 'pct', hadSavedImage: false,
};

// ---------------- ACCESO ----------------
function buildKeypad(box) {
  const target = $('#' + box.dataset.target);
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'];
  box.innerHTML = keys.map((k) => k === 'clear' ? '<button type="button" class="fn" data-k="clear">Borrar</button>'
    : k === 'del' ? '<button type="button" class="fn" data-k="del" aria-label="Borrar último">⌫</button>'
    : `<button type="button" data-k="${k}">${k}</button>`).join('');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'clear') target.value = '';
    else if (k === 'del') target.value = target.value.slice(0, -1);
    else if (target.value.length < 4) target.value += k;
    target.dispatchEvent(new Event('input'));
  });
}

function paintDots() {
  const v = $('#loginPin').value;
  $$('#loginDots i').forEach((d, i) => d.classList.toggle('on', i < v.length));
}

let loggingIn = false;
async function tryLogin() {
  const name = $('#loginName').value.trim(), pin = $('#loginPin').value;
  if (pin.length < 4 || loggingIn) return;
  if (!name) { $('#loginMsg').textContent = 'Escribe tu nombre primero.'; $('#loginPin').value = ''; paintDots(); $('#loginName').focus(); return; }
  loggingIn = true; $('#loginMsg').textContent = '';
  try {
    await api('POST', '/login', { name, pin });
    try { localStorage.setItem('cot_name', name); } catch {}
    await enterApp();
  } catch (e) {
    $('#loginMsg').textContent = e.message;
    const dots = $('#loginDots'); dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake');
    $('#loginPin').value = ''; paintDots();
  } finally { loggingIn = false; }
}

function showAuth(needsSetup) {
  $('#app').hidden = true; $('#auth').hidden = false;
  $('#loginForm').hidden = !!needsSetup; $('#setupForm').hidden = !needsSetup;
  $('#loginPin').value = ''; paintDots();
  try { const n = localStorage.getItem('cot_name'); if (n && !$('#loginName').value) $('#loginName').value = n; } catch {}
}

$('#loginPin').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); paintDots(); if (e.target.value.length === 4) tryLogin(); });
$('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); tryLogin(); });
$('#loginDots').addEventListener('click', () => $('#loginPin').focus());
document.addEventListener('keydown', (e) => {
  if ($('#auth').hidden || $('#loginForm').hidden || document.activeElement === $('#loginName')) return;
  const p = $('#loginPin');
  if (/^\d$/.test(e.key) && p.value.length < 4) { p.value += e.key; p.dispatchEvent(new Event('input')); e.preventDefault(); }
  else if (e.key === 'Backspace') { p.value = p.value.slice(0, -1); p.dispatchEvent(new Event('input')); e.preventDefault(); }
});
$('#loginName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#loginName').blur(); } });

$('#setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#setupName').value.trim(), pin = $('#setupPin').value, pin2 = $('#setupPin2').value;
  const m = $('#setupMsg');
  if (!/^\d{4}$/.test(pin)) return (m.textContent = 'El código debe tener 4 números.');
  if (pin !== pin2) return (m.textContent = 'Los códigos no coinciden.');
  try {
    await api('POST', '/setup', { name, pin, setupKey: $('#setupKey').value });
    try { localStorage.setItem('cot_name', name); } catch {}
    await enterApp();
  } catch (err) { m.textContent = err.message; }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/logout'); } catch {}
  showAuth(false);
});

// ---------------- NAVEGACIÓN ----------------
function showView(v) {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  ['editor', 'list', 'settings'].forEach((x) => { $('#view-' + x).hidden = x !== v; });
  if (v === 'list') loadList();
  if (v === 'settings') { fillSettings(); loadUsers(); }
  if (v === 'editor') requestAnimationFrame(() => $$('#items textarea').forEach(autoGrow));
  window.scrollTo(0, 0);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

async function enterApp() {
  $('#auth').hidden = true; $('#app').hidden = false;
  await loadSettings();
  if (!st.items.length) newQuote();
  if (!settings.configured) startWelcome(); else showView('editor');
}

// Primera vez: pide los datos de la empresa antes de empezar a cotizar
function setWelcome(on) {
  $('.tabs').hidden = on;
  $('#setTitle').textContent = on ? 'Bienvenido: datos de tu empresa' : 'Ajustes';
  $('#welcomeNote').hidden = !on;
  $('#pinCard').hidden = on; $('#usersCard').hidden = on;
  $('#saveSettings').textContent = on ? 'Guardar y empezar a cotizar' : 'Guardar ajustes';
}
function startWelcome() { setWelcome(true); showView('settings'); }

// ---------------- AJUSTES ----------------
function loadImageMeta(dataUrl) {
  return new Promise((ok) => {
    if (!dataUrl) return ok(null);
    const im = new Image();
    im.onload = () => ok({ data: dataUrl, w: im.naturalWidth, h: im.naturalHeight, fmt: dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG' });
    im.onerror = () => ok(null);
    im.src = dataUrl;
  });
}

async function loadSettings() {
  try { settings = await api('GET', '/settings'); } catch { settings = {}; }
  logoMeta = await getLogoMeta(settings.logo);
  paintBrand();
}

// Logo de ProToldos incluido en la página; se usa mientras no subas otro
const DEFAULT_LOGO = '/logo-protoldos.png';
let defaultLogoData = null;
async function getLogoMeta(custom) {
  if (custom) return loadImageMeta(custom);
  if (!defaultLogoData) {
    try {
      const blob = await (await fetch(DEFAULT_LOGO)).blob();
      defaultLogoData = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
    } catch { return null; }
  }
  return loadImageMeta(defaultLogoData);
}
function paintBrand() {
  const name = settings.tradeName || 'ProToldos';
  $('#topName').textContent = name;
  const tl = $('#topLogo');
  tl.hidden = false; tl.classList.toggle('custom', !!settings.logo);
  tl.src = settings.logo || '/logo-protoldos-blanco.png';
}

const SET_FIELDS = { sTrade: 'tradeName', sLegal: 'legalName', sRut: 'rut', sGiro: 'giro', sAddress: 'address', sPhone: 'phone', sEmail: 'email', sWeb: 'web', sSeller: 'seller', sBank: 'bank', sCond: 'conditions', sIva: 'ivaRate', sValid: 'validDays' };
function fillSettings() {
  for (const [id, k] of Object.entries(SET_FIELDS)) $('#' + id).value = settings[k] ?? '';
  if (settings.ivaRate == null) $('#sIva').value = 19;
  if (!settings.validDays) $('#sValid').value = 15;
  if (!settings.tradeName) $('#sTrade').value = 'ProToldos';
  if (!settings.web) $('#sWeb').value = 'www.protoldos.cl';
  showLogo(settings.logo);
}
function showLogo(data) {
  $('#logoPreview').hidden = false; $('#logoEmpty').hidden = true; $('#logoRemove').hidden = !data;
  $('#logoPreview').src = data || DEFAULT_LOGO;
}
let pendingLogo;  // undefined = sin cambio
$('#saveSettings').addEventListener('click', async () => {
  const s = {};
  for (const [id, k] of Object.entries(SET_FIELDS)) s[k] = $('#' + id).value.trim();
  s.ivaRate = numv(s.ivaRate); s.validDays = Math.round(numv(s.validDays)) || 15;
  s.logo = pendingLogo !== undefined ? pendingLogo : (settings.logo || '');
  try {
    await api('PUT', '/settings', s);
    settings = s; pendingLogo = undefined; logoMeta = await getLogoMeta(s.logo);
    const first = !settings.configured; settings.configured = true;
    paintBrand(); recalc(); toast(first ? 'Listo. Ya puedes hacer tu primera cotización.' : 'Ajustes guardados');
    if (first) { setWelcome(false); showView('editor'); }
    if (!st.id && !$('#qNotes').value.trim() && s.conditions) $('#qNotes').value = s.conditions;
  } catch (e) { toast(e.message, true); }
});

// imagen → JPEG/PNG comprimido
function fileToImage(file) {
  return new Promise((ok, bad) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); ok(im); };
    im.onerror = () => { URL.revokeObjectURL(url); bad(new Error('No se pudo leer la imagen.')); };
    im.src = url;
  });
}
function imageToData(im, maxSide, type, quality) {
  const r = Math.min(1, maxSide / Math.max(im.naturalWidth || im.width, im.naturalHeight || im.height));
  const w = Math.round((im.naturalWidth || im.width) * r), h = Math.round((im.naturalHeight || im.height) * r);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  ctx.drawImage(im, 0, 0, w, h);
  return { data: c.toDataURL(type, quality), w, h, fmt: type === 'image/png' ? 'PNG' : 'JPEG' };
}

function setupDrop(drop, input, onFile) {
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) onFile(f); });
  input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; if (f) onFile(f); });
}

setupDrop($('#logoDrop'), $('#logoFile'), async (f) => {
  try {
    const im = await fileToImage(f);
    const png = /png|webp|gif/.test(f.type);
    let out = imageToData(im, 600, png ? 'image/png' : 'image/jpeg', 0.9);
    if (out.data.length > 850000) out = imageToData(im, 400, png ? 'image/png' : 'image/jpeg', 0.85);
    if (out.data.length > 850000) out = imageToData(im, 400, 'image/jpeg', 0.85);
    pendingLogo = out.data; showLogo(out.data);
    toast('Logo listo. Aprieta "Guardar ajustes".');
  } catch (e) { toast(e.message, true); }
});
$('#logoRemove').addEventListener('click', () => { pendingLogo = ''; showLogo(''); });

$('#changePin').addEventListener('click', async () => {
  const cur = $('#pinCur').value, nw = $('#pinNew').value, nw2 = $('#pinNew2').value;
  if (!/^\d{4}$/.test(nw)) return toast('El código nuevo debe tener 4 números.', true);
  if (nw !== nw2) return toast('Los códigos nuevos no coinciden.', true);
  try { await api('POST', '/pin', { current: cur, next: nw }); ['pinCur', 'pinNew', 'pinNew2'].forEach((i) => ($('#' + i).value = '')); toast('Código cambiado'); }
  catch (e) { toast(e.message, true); }
});

async function loadUsers() {
  try {
    const me = (await api('GET', '/status')).user;
    const us = await api('GET', '/users');
    $('#users').innerHTML = us.map((u) => `<div><span>${esc(u.name)}${u.id === me?.id ? ' <small>(tú)</small>' : ''}</span>${u.id === me?.id ? '' : `<button class="btn line sm danger" data-del-user="${u.id}" data-name="${esc(u.name)}">Quitar</button>`}</div>`).join('');
  } catch {}
}
$('#users').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-user]'); if (!b) return;
  if (!confirm(`¿Quitar el acceso de ${b.dataset.name}?`)) return;
  try { await api('DELETE', '/users/' + b.dataset.delUser); loadUsers(); toast('Cuenta quitada'); } catch (er) { toast(er.message, true); }
});
$('#addUser').addEventListener('click', async () => {
  const name = $('#uName').value.trim(), pin = $('#uPin').value;
  try { await api('POST', '/users', { name, pin }); $('#uName').value = ''; $('#uPin').value = ''; loadUsers(); toast('Cuenta agregada'); }
  catch (e) { toast(e.message, true); }
});

// ---------------- EDITOR ----------------
const ivaRate = () => (settings.ivaRate == null || settings.ivaRate === '' ? 19 : numv(settings.ivaRate));

function calc() {
  const rate = ivaRate();
  const rows = st.items.map((it) => {
    const net = Math.round(numv(it.qty) * numv(it.price));
    const iva = Math.round(net * rate / 100);
    return { net, iva, total: net + iva };
  });
  const subtotal = rows.reduce((s, r) => s + r.net, 0);
  const dv = numv($('#discValue').value);
  let discount = st.discType === 'amt' ? Math.round(dv) : Math.round(subtotal * Math.min(Math.max(dv, 0), 100) / 100);
  discount = Math.min(Math.max(discount, 0), subtotal);
  const net = subtotal - discount;
  const iva = Math.round(net * rate / 100);
  return { rows, subtotal, discount, net, iva, total: net + iva, rate, dv };
}

function itemHTML(it, i) {
  return `<div class="item" data-i="${i}">
    <div class="i-qty"><span class="mlbl">Cant.</span><input class="inp" data-f="qty" type="number" min="0" step="any" inputmode="decimal" value="${esc(it.qty)}" aria-label="Cantidad"></div>
    <div class="i-desc"><span class="mlbl">Descripción del producto</span><textarea class="inp i-desc-in" data-f="desc" rows="1" maxlength="2000" aria-label="Descripción" placeholder="Ej: Toldo retráctil 4 x 3 m, lona acrílica">${esc(it.desc)}</textarea></div>
    <div class="i-price"><span class="mlbl">Precio unitario (sin IVA)</span><div class="price-wrap"><input class="inp" data-f="price" type="text" inputmode="numeric" value="${it.price ? Math.round(it.price).toLocaleString('es-CL') : ''}" aria-label="Precio unitario sin IVA" placeholder="0"></div></div>
    <div class="i-calc"><span><em>Neto </em><b data-c="net">$0</b></span><span><em>IVA </em><b data-c="iva">$0</b></span><span><em>Total </em><b data-c="total">$0</b></span></div>
    <button type="button" class="i-del" aria-label="Eliminar fila" title="Eliminar fila">✕</button>
  </div>`;
}
function renderItems() {
  $('#items').innerHTML = st.items.map(itemHTML).join('');
  $$('#items textarea').forEach(autoGrow);
  recalc();
}
function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.max(42, t.scrollHeight + 2) + 'px'; }

function recalc() {
  const c = calc();
  $$('#items .item').forEach((el, i) => {
    const r = c.rows[i]; if (!r) return;
    el.querySelector('[data-c="net"]').textContent = clp(r.net);
    el.querySelector('[data-c="iva"]').textContent = clp(r.iva);
    el.querySelector('[data-c="total"]').textContent = clp(r.total);
  });
  $('#tSub').textContent = clp(c.subtotal);
  $('#tDisc').textContent = '-' + clp(c.discount);
  $('#tDiscLbl').textContent = st.discType === 'pct' && c.dv ? `Descuento (${c.dv.toLocaleString('es-CL')}%)` : 'Descuento';
  $('#tNet').textContent = clp(c.net);
  $('#tIvaLbl').textContent = `IVA ${c.rate.toLocaleString('es-CL')}%`;
  $('#tIva').textContent = clp(c.iva);
  $('#tTotal').textContent = clp(c.total);
  $('.disc-line').hidden = !c.discount;
  return c;
}

$('#items').addEventListener('input', (e) => {
  const el = e.target.closest('.item'); if (!el) return;
  const it = st.items[+el.dataset.i]; const f = e.target.dataset.f;
  if (f === 'price') {
    const digits = e.target.value.replace(/\D/g, '');
    it.price = digits ? Number(digits) : 0;
    const pos = e.target.value.length - e.target.selectionStart;
    e.target.value = digits ? Number(digits).toLocaleString('es-CL') : '';
    const np = Math.max(0, e.target.value.length - pos); e.target.setSelectionRange(np, np);
  } else if (f === 'qty') it.qty = e.target.value;
  else if (f === 'desc') { it.desc = e.target.value; autoGrow(e.target); }
  recalc();
});
$('#items').addEventListener('click', (e) => {
  if (!e.target.closest('.i-del')) return;
  const i = +e.target.closest('.item').dataset.i;
  st.items.splice(i, 1);
  if (!st.items.length) st.items.push({ qty: 1, desc: '', price: 0 });
  renderItems();
});
$('#addItem').addEventListener('click', () => {
  st.items.push({ qty: 1, desc: '', price: 0 }); renderItems();
  const last = $$('#items .item').pop(); last?.querySelector('textarea')?.focus();
});
$('#discValue').addEventListener('input', recalc);
$$('.seg button').forEach((b) => b.addEventListener('click', () => {
  st.discType = b.dataset.dt; $$('.seg button').forEach((x) => x.classList.toggle('on', x === b)); recalc();
}));

// imagen del proyecto
function showImg() {
  $('#imgPreview').hidden = !st.img; $('#imgEmpty').hidden = !!st.img; $('#imgRemove').hidden = !st.img;
  if (st.img) $('#imgPreview').src = st.img.data;
  $('#imgNote').hidden = !(st.hadSavedImage && !st.img);
  $('#imgChange').hidden = !st.img;
}
let imgSource = null;  // imagen original para recomprimir si el PDF pesa mucho
setupDrop($('#imgDrop'), $('#imgFile'), async (f) => {
  try {
    imgSource = await fileToImage(f);
    st.img = imageToData(imgSource, 1600, 'image/jpeg', 0.82);
    showImg();
  } catch (e) { toast(e.message, true); }
});
$('#imgChange').addEventListener('click', () => $('#imgFile').click());
$('#imgRemove').addEventListener('click', () => { st.img = null; imgSource = null; showImg(); });

const CLIENT_IDS = { cCompany: 'company', cContact: 'contact', cRut: 'rut', cPhone: 'phone', cEmail: 'email', cAddress: 'address' };

function newQuote() {
  st.id = null; st.number = null; st.img = null; imgSource = null; st.hadSavedImage = false; st.discType = 'pct';
  st.items = [{ qty: 1, desc: '', price: 0 }];
  Object.keys(CLIENT_IDS).forEach((id) => ($('#' + id).value = ''));
  $('#qDate').value = today();
  $('#qValid').value = settings.validDays || 15;
  $('#qNotes').value = settings.conditions || '';
  $('#discValue').value = 0;
  $$('.seg button').forEach((x) => x.classList.toggle('on', x.dataset.dt === 'pct'));
  $('#edTitle').textContent = 'Nueva cotización'; $('#edBadge').hidden = true;
  showImg(); renderItems();
  savedSnapshot = snapshot();
}
$('#newBtn').addEventListener('click', () => {
  if (isDirty() && !confirm('¿Empezar una cotización nueva? Lo que no guardaste se pierde.')) return;
  newQuote(); window.scrollTo(0, 0);
});
let savedSnapshot = '';
const snapshot = () => JSON.stringify(collect()) + (st.img ? st.img.data.length : 0);
const isDirty = () => snapshot() !== savedSnapshot && (st.items.some((i) => i.desc || i.price) || $('#cCompany').value);

function collect() {
  const client = {};
  for (const [id, k] of Object.entries(CLIENT_IDS)) client[k] = $('#' + id).value.trim();
  return {
    client, date: $('#qDate').value || today(), validDays: Math.round(numv($('#qValid').value)) || 15,
    items: st.items.map((i) => ({ qty: numv(i.qty), desc: (i.desc || '').trim(), price: Math.round(numv(i.price)) }))
      .filter((i) => i.desc || i.price),
    discountType: st.discType, discountValue: numv($('#discValue').value), ivaRate: ivaRate(), notes: $('#qNotes').value.trim(),
  };
}

async function openQuote(id) {
  try {
    const q = await api('GET', '/quotes/' + id);
    st.id = q.id; st.number = q.number; st.img = null; imgSource = null; st.hadSavedImage = q.hasPdf; st.discType = q.discountType;
    for (const [idd, k] of Object.entries(CLIENT_IDS)) $('#' + idd).value = q.client[k] || '';
    $('#qDate').value = q.date; $('#qValid').value = q.validDays; $('#qNotes').value = q.notes;
    $('#discValue').value = q.discountValue;
    $$('.seg button').forEach((x) => x.classList.toggle('on', x.dataset.dt === q.discountType));
    st.items = q.items.length ? q.items : [{ qty: 1, desc: '', price: 0 }];
    if (q.ivaRate !== ivaRate()) toast(`Ojo: esta cotización usó IVA ${q.ivaRate}% y ahora está en ${ivaRate()}%.`);
    $('#edTitle').textContent = 'Editando cotización'; $('#edBadge').textContent = 'N° ' + pad4(q.number); $('#edBadge').hidden = false;
    showImg(); renderItems(); showView('editor');
    savedSnapshot = snapshot();
  } catch (e) { toast(e.message, true); }
}

// ---------------- PDF ----------------
function buildPdf(data, number) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const W = 210, H = 297, M = 14, CW = W - M * 2;
  const BRAND = [18, 52, 77], ACCENT = [242, 163, 58], INK = [28, 36, 44], MUTED = [104, 117, 130];
  const SOFT = [244, 246, 248], LINE = [226, 231, 236];
  const rate = data.ivaRate;
  const s = settings;
  const c = (() => {
    const rows = data.items.map((it) => { const net = Math.round(it.qty * it.price); const iva = Math.round(net * rate / 100); return { net, iva, total: net + iva }; });
    const subtotal = rows.reduce((a, r) => a + r.net, 0);
    let discount = data.discountType === 'amt' ? Math.round(data.discountValue) : Math.round(subtotal * Math.min(data.discountValue, 100) / 100);
    discount = Math.min(Math.max(discount, 0), subtotal);
    const net = subtotal - discount, iva = Math.round(net * rate / 100);
    return { rows, subtotal, discount, net, iva, total: net + iva };
  })();
  const font = (style, size, color) => { doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color); };
  const label = (t, x, yy) => { font('bold', 7.5, MUTED); doc.setCharSpace(0.4); doc.text(t.toUpperCase(), x, yy); doc.setCharSpace(0); };

  // Franja superior
  doc.setFillColor(...BRAND); doc.rect(0, 0, W, 4, 'F');
  doc.setFillColor(...ACCENT); doc.rect(0, 4, W, 0.9, 'F');

  // ---- Encabezado: logo + empresa (izq.) / cuadro de cotización (der.)
  let y = 12;
  const boxW = 62, boxX = W - M - boxW;
  let ly = y;
  if (logoMeta) {
    const r = Math.min(58 / logoMeta.w, 20 / logoMeta.h);
    doc.addImage(logoMeta.data, logoMeta.fmt, M, ly, logoMeta.w * r, logoMeta.h * r, 'logo', 'FAST');
    ly += logoMeta.h * r + 7;
  } else {
    font('bold', 20, BRAND); doc.text(s.tradeName || 'ProToldos', M, ly + 7); ly += 12;
  }
  const leftW = boxX - M - 8;
  if (s.legalName) { font('bold', 9.5, INK); doc.text(doc.splitTextToSize(s.legalName, leftW)[0], M, ly); ly += 4.3; }
  const info = [s.rut ? 'RUT ' + s.rut : '', s.giro, s.address, [s.phone, s.email].filter(Boolean).join('  |  '), s.web].filter(Boolean);
  font('normal', 8, MUTED);
  info.forEach((l) => { const t = doc.splitTextToSize(l, leftW); doc.text(t, M, ly); ly += 3.7 * t.length; });

  // cuadro de cotización
  doc.setFillColor(...SOFT); doc.roundedRect(boxX, y, boxW, 33, 2.5, 2.5, 'F');
  doc.setFillColor(...BRAND); doc.roundedRect(boxX, y, boxW, 12, 2.5, 2.5, 'F'); doc.rect(boxX, y + 8, boxW, 4, 'F');
  font('bold', 13, [255, 255, 255]); doc.setCharSpace(0.8); doc.text('COTIZACIÓN', boxX + boxW / 2, y + 8, { align: 'center' }); doc.setCharSpace(0);
  const meta = [['N°', pad4(number)], ['Fecha', fmtDate(data.date)], ['Válida hasta', fmtDate(addDays(data.date, data.validDays))]];
  meta.forEach(([k, v], i) => {
    const yy = y + 17.5 + i * 5.2;
    font('normal', 8.5, MUTED); doc.text(k, boxX + 4, yy);
    font('bold', i === 0 ? 10 : 8.5, i === 0 ? BRAND : INK); doc.text(v, boxX + boxW - 4, yy, { align: 'right' });
  });
  y = Math.max(ly, y + 33) + 5;

  // ---- Cliente
  const cl = data.client;
  const pairs = [['Empresa', cl.company], ['RUT', cl.rut], ['Contacto', cl.contact], ['Teléfono', cl.phone], ['Correo', cl.email], ['Dirección', cl.address]].filter((p) => p[1]);
  const half = Math.ceil(pairs.length / 2);
  const cols = [pairs.slice(0, half), pairs.slice(half)];
  const cH = 9 + Math.max(half, 1) * 5;
  doc.setDrawColor(...LINE); doc.setLineWidth(0.3); doc.roundedRect(M, y, CW, cH, 2.5, 2.5, 'S');
  doc.setFillColor(...ACCENT); doc.rect(M, y + 3, 1.2, cH - 6, 'F');
  label('Cliente', M + 5, y + 5.5);
  cols.forEach((col, ci) => col.forEach(([k, v], i) => {
    const x = M + 5 + ci * (CW / 2), yy = y + 10.8 + i * 5;
    font('normal', 8.5, MUTED); doc.text(k, x, yy);
    font(k === 'Empresa' ? 'bold' : 'normal', 9, INK); doc.text(doc.splitTextToSize(String(v), CW / 2 - 28)[0], x + 18, yy);
  }));
  y += cH + 6;

  // ---- Tabla
  const body = data.items.map((it, i) => [
    (it.qty % 1 ? it.qty.toLocaleString('es-CL') : String(it.qty)), it.desc, clp(it.price), clp(c.rows[i].net), clp(c.rows[i].iva), clp(c.rows[i].total),
  ]);
  doc.autoTable({
    startY: y, margin: { left: M, right: M, bottom: 18 },
    head: [['Cant.', 'Descripción', 'P. unitario', 'Neto', `IVA ${rate}%`, 'Total']],
    body: body.length ? body : [['', 'Sin productos', '', '', '', '']],
    theme: 'plain',
    styles: { font: 'helvetica', fontSize: 8.8, cellPadding: { top: 2.6, bottom: 2.6, left: 2.5, right: 2.5 }, textColor: INK, valign: 'middle' },
    headStyles: { fillColor: BRAND, textColor: 255, fontStyle: 'bold', fontSize: 8, cellPadding: { top: 3, bottom: 3, left: 2.5, right: 2.5 } },
    alternateRowStyles: { fillColor: [249, 250, 251] },
    columnStyles: {
      0: { cellWidth: 14, halign: 'center' }, 1: { cellWidth: 'auto' },
      2: { cellWidth: 26, halign: 'right', textColor: MUTED }, 3: { cellWidth: 24, halign: 'right' }, 4: { cellWidth: 22, halign: 'right', textColor: MUTED }, 5: { cellWidth: 27, halign: 'right', fontStyle: 'bold' },
    },
    didParseCell: (h) => { if (h.section === 'head') h.cell.styles.halign = h.column.index === 0 ? 'center' : h.column.index === 1 ? 'left' : 'right'; },
    didDrawCell: (h) => { if (h.section === 'body') { doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(h.cell.x, h.cell.y + h.cell.height, h.cell.x + h.cell.width, h.cell.y + h.cell.height); } },
  });
  y = doc.lastAutoTable.finalY + 5;

  // ---- Totales
  const tRows = [['Subtotal neto', clp(c.subtotal), INK]];
  if (c.discount) tRows.push([data.discountType === 'pct' ? `Descuento (${data.discountValue.toLocaleString('es-CL')}%)` : 'Descuento', '- ' + clp(c.discount), [192, 57, 43]], ['Neto', clp(c.net), INK]);
  tRows.push([`IVA ${rate}%`, clp(c.iva), INK]);
  const tw = 80, tx = W - M - tw, rowH = 5.8, th = tRows.length * rowH + 4 + 12;
  if (y + th > H - 20) { doc.addPage(); y = M; }
  doc.setFillColor(...SOFT); doc.roundedRect(tx, y, tw, th, 2.5, 2.5, 'F');
  tRows.forEach(([k, v, col], i) => {
    const yy = y + 6 + i * rowH;
    font('normal', 8.8, MUTED); doc.text(k, tx + 4, yy);
    font('bold', 8.8, col); doc.text(v, W - M - 4, yy, { align: 'right' });
  });
  const gy = y + tRows.length * rowH + 4;
  doc.setFillColor(...BRAND); doc.roundedRect(tx, gy, tw, 12, 2.5, 2.5, 'F'); doc.rect(tx, gy, tw, 3, 'F');
  font('bold', 9, [200, 214, 226]); doc.setCharSpace(0.6); doc.text('TOTAL', tx + 4, gy + 7.6); doc.setCharSpace(0);
  font('bold', 13.5, [255, 255, 255]); doc.text(clp(c.total), W - M - 4, gy + 8, { align: 'right' });
  // nota de validez al lado de los totales
  font('normal', 7.8, MUTED);
  doc.text(doc.splitTextToSize(`Valores en pesos chilenos. Precios unitarios netos; el IVA se calcula sobre el neto${c.discount ? ' con descuento' : ''}.`, tx - M - 8), M, y + 5);
  y += th + 6;

  // ---- Observaciones
  const block = (title, text) => {
    if (!text) return;
    font('normal', 8.8, INK); const lines = doc.splitTextToSize(text, CW - 10);
    const bh = 9 + lines.length * 4;
    if (y + bh > H - 20) { doc.addPage(); y = M; }
    doc.setFillColor(...SOFT); doc.roundedRect(M, y, CW, bh, 2.5, 2.5, 'F');
    label(title, M + 5, y + 5.5);
    font('normal', 8.8, INK); doc.text(lines, M + 5, y + 10.3);
    y += bh + 5;
  };
  block('Observaciones', data.notes);
  if (s.seller) block('Atendido por', s.seller);

  // ---- Imagen del proyecto: grande, en la misma hoja (un poco más chica que el espacio total)
  if (data.img) {
    const ratio = data.img.h / data.img.w;
    const bottom = H - 16;
    let free = bottom - (y + 5);
    if (free < 45) { doc.addPage(); y = M; free = bottom - (y + 5); }
    const SCALE = 0.92;
    let iw = CW * SCALE, ih = iw * ratio;
    if (ih > free * SCALE) { ih = free * SCALE; iw = ih / ratio; }
    label('Imagen referencial del proyecto', M, y + 1); y += 4;
    const ix = M + (CW - iw) / 2;
    doc.setFillColor(...SOFT); doc.roundedRect(ix - 1.5, y - 1.5, iw + 3, ih + 3, 2, 2, 'F');
    doc.addImage(data.img.data, 'JPEG', ix, y, iw, ih, 'proyecto', 'MEDIUM');
    y += ih + 4;
  }

  // ---- Pie
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFillColor(...BRAND); doc.rect(0, H - 9, W, 9, 'F');
    font('normal', 7.5, [205, 218, 228]);
    doc.text([s.tradeName || 'ProToldos', s.web, s.phone, s.email].filter(Boolean).join('   ·   '), M, H - 3.6);
    doc.text(`N° ${pad4(number)}  ·  ${p}/${pages}`, W - M, H - 3.6, { align: 'right' });
  }
  doc.setProperties({ title: `Cotización ${pad4(number)} - ${data.client.company || ''}`, author: s.tradeName || 'ProToldos' });
  return doc;
}

function pdfName(number, company) {
  const clean = (company || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `Cotizacion-${pad4(number)}${clean ? '-' + clean : ''}.pdf`;
}

let modalUrl = null;
function showPdf(blob, title, filename) {
  if (modalUrl) URL.revokeObjectURL(modalUrl);
  modalUrl = URL.createObjectURL(blob);
  $('#pdfTitle').textContent = title;
  $('#pdfDownload').href = modalUrl; $('#pdfDownload').download = filename;
  const mobile = matchMedia('(max-width: 719px)').matches || /iPhone|iPad|Android/i.test(navigator.userAgent);
  if (mobile) { // los celulares no muestran bien PDFs dentro de la página
    const w = window.open(modalUrl, '_blank');
    if (w) return;
  }
  $('#pdfFrame').src = modalUrl;
  $('#pdfModal').hidden = false;
}
$('#pdfClose').addEventListener('click', () => { $('#pdfModal').hidden = true; $('#pdfFrame').src = 'about:blank'; });
$('#pdfOpen').addEventListener('click', () => { if (modalUrl) window.open(modalUrl, '_blank'); });
$('#pdfModal').addEventListener('click', (e) => { if (e.target.id === 'pdfModal') $('#pdfClose').click(); });

function currentPdf() {
  const data = collect(); data.img = st.img;
  return { doc: buildPdf(data, st.number || 0), data };
}
$('#previewBtn').addEventListener('click', () => {
  try {
    const { doc, data } = currentPdf();
    showPdf(doc.output('blob'), st.number ? 'Cotización N° ' + pad4(st.number) : 'Vista previa (sin guardar)', pdfName(st.number || 0, data.client.company));
  } catch (e) { console.error(e); toast('No se pudo generar el PDF.', true); }
});
$('#printBtn').addEventListener('click', () => {
  try {
    const { doc } = currentPdf();
    doc.autoPrint();
    const url = URL.createObjectURL(doc.output('blob'));
    const w = window.open(url, '_blank');
    if (!w) toast('Tu navegador bloqueó la ventana. Usa "Ver PDF" y luego imprime.', true);
  } catch (e) { console.error(e); toast('No se pudo generar el PDF.', true); }
});

$('#saveBtn').addEventListener('click', async () => {
  const data = collect();
  if (!data.client.company) { toast('Escribe el nombre de la empresa o cliente.', true); $('#cCompany').focus(); return; }
  if (!data.items.length) { toast('Agrega al menos un producto.', true); return; }
  const btn = $('#saveBtn'); btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const r = st.id ? await api('PUT', '/quotes/' + st.id, data) : await api('POST', '/quotes', data);
    st.id = r.id; st.number = r.number;
    // Genera el PDF con el número asignado. Si pesa mucho, baja la calidad de la imagen.
    let img = st.img, blob;
    for (let attempt = 0; attempt < 4; attempt++) {
      blob = buildPdf({ ...data, img }, st.number).output('blob');
      if (blob.size <= 1_850_000 || !img) break;
      const side = [1300, 1000, 800][attempt] || 800;
      img = imgSource ? imageToData(imgSource, side, 'image/jpeg', 0.72) : null;
    }
    await api('PUT', `/quotes/${st.id}/pdf`, undefined, blob);
    st.hadSavedImage = !!img; if (img !== st.img) st.img = img;  // la imagen queda solo en este navegador mientras sigas editando
    $('#edTitle').textContent = 'Editando cotización'; $('#edBadge').textContent = 'N° ' + pad4(st.number); $('#edBadge').hidden = false;
    showImg(); savedSnapshot = snapshot();
    toast(`Cotización N° ${pad4(st.number)} guardada (${Math.round(blob.size / 1024)} KB)`);
    showPdf(blob, 'Cotización N° ' + pad4(st.number), pdfName(st.number, data.client.company));
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Guardar'; }
});

// ---------------- LISTA ----------------
let searchT;
$('#search').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(loadList, 250); });
async function loadList() {
  const q = $('#search').value.trim();
  const box = $('#list');
  try {
    const rows = await api('GET', '/quotes' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (!rows.length) { box.innerHTML = `<p class="empty">${q ? 'No hay cotizaciones que coincidan con "' + esc(q) + '".' : 'Todavía no hay cotizaciones guardadas.'}</p>`; return; }
    box.innerHTML = rows.map((r) => `<article class="qcard">
      <div class="qtop"><b>${esc(r.client.company || 'Sin nombre')}</b><span class="qnum">N° ${pad4(r.number)}</span></div>
      <div class="qmeta">${fmtDate(r.date)}${r.client.contact ? ' · ' + esc(r.client.contact) : ''}${r.client.rut ? ' · ' + esc(r.client.rut) : ''}</div>
      <div class="qtop"><span class="qtotal">${clp(r.total)}</span><span class="qmeta">${r.hasPdf ? 'PDF ' + Math.round(r.pdfSize / 1024) + ' KB' : 'Sin PDF'}</span></div>
      <div class="qbtns">
        ${r.hasPdf ? `<button class="btn line sm" data-act="pdf" data-id="${r.id}" data-n="${r.number}" data-c="${esc(r.client.company)}">Ver PDF</button>
        <a class="btn line sm" href="/api/quotes/${r.id}/pdf?dl=1">Descargar</a>` : ''}
        <button class="btn line sm" data-act="edit" data-id="${r.id}">Editar</button>
        <button class="btn line sm danger" data-act="del" data-id="${r.id}" data-n="${r.number}">Eliminar</button>
      </div></article>`).join('');
  } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}
$('#list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.dataset.id;
  if (b.dataset.act === 'edit') {
    if (isDirty() && !confirm('Tienes cambios sin guardar en el editor. ¿Abrir esta cotización de todas formas?')) return;
    openQuote(id);
  }
  if (b.dataset.act === 'pdf') {
    try {
      const res = await fetch(`/api/quotes/${id}/pdf`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('No se pudo abrir el PDF.');
      showPdf(await res.blob(), 'Cotización N° ' + pad4(b.dataset.n), pdfName(b.dataset.n, b.dataset.c));
    } catch (er) { toast(er.message, true); }
  }
  if (b.dataset.act === 'del') {
    if (!confirm(`¿Eliminar la cotización N° ${pad4(b.dataset.n)}? No se puede deshacer.`)) return;
    try { await api('DELETE', '/quotes/' + id); if (String(st.id) === id) newQuote(); loadList(); toast('Cotización eliminada'); }
    catch (er) { toast(er.message, true); }
  }
});

window.addEventListener('beforeunload', (e) => { if (!$('#app').hidden && isDirty()) { e.preventDefault(); e.returnValue = ''; } });

// ---------------- inicio ----------------
buildKeypad($('.keypad'));
(async () => {
  try {
    const s = await api('GET', '/status');
    if (s.user) await enterApp();
    else showAuth(s.needsSetup);
    if (s.needsSetup && !s.setupEnabled) $('#setupMsg').textContent = 'Falta configurar SETUP_KEY en Cloudflare (ver LEEME).';
  } catch (e) {
    showAuth(false);
    $('#loginMsg').textContent = e.message;
  }
})();
})();
