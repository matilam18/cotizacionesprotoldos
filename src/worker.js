// Cotizador ProToldos — servidor (Cloudflare Pages, modo avanzado con _worker.js)
// Base de datos: Neon (Postgres) por HTTP.
// Necesita en el proyecto de Pages (Settings → Variables and secrets):
//   - DATABASE_URL  (secreto): cadena de conexión de Neon, postgresql://...
//   - SETUP_KEY     (secreto): clave para crear la primera cuenta
//
// Este archivo es el código fuente. `npm run build` lo empaqueta en public/_worker.js.

import { neon, neonConfig } from '@neondatabase/serverless';

const IVA_DEFAULT = 19;
const SESSION_DAYS = 30;
const MAX_PDF = 1_900_000;
const MAX_JSON = 1_200_000;
const PBKDF2_ITER = 100_000;      // máximo permitido por Workers

// Las tablas se crean en Neon con este mismo esquema la primera vez (si no existen).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower ON users (lower(name))`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (k TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, locked_until BIGINT NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS quotes (id SERIAL PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
     client_company TEXT NOT NULL DEFAULT '', client_contact TEXT NOT NULL DEFAULT '', client_rut TEXT NOT NULL DEFAULT '',
     client_phone TEXT NOT NULL DEFAULT '', client_email TEXT NOT NULL DEFAULT '', client_address TEXT NOT NULL DEFAULT '',
     quote_date TEXT NOT NULL, valid_days INTEGER NOT NULL DEFAULT 15, items_json TEXT NOT NULL,
     discount_type TEXT NOT NULL DEFAULT 'pct', discount_value DOUBLE PRECISION NOT NULL DEFAULT 0, iva_rate DOUBLE PRECISION NOT NULL DEFAULT 19,
     notes TEXT NOT NULL DEFAULT '', subtotal BIGINT NOT NULL DEFAULT 0, discount_amount BIGINT NOT NULL DEFAULT 0, net BIGINT NOT NULL DEFAULT 0,
     iva BIGINT NOT NULL DEFAULT 0, total BIGINT NOT NULL DEFAULT 0, pdf BYTEA, pdf_size INTEGER NOT NULL DEFAULT 0, created_by INTEGER,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS quotes_company_lower ON quotes (lower(client_company))`,
];

// ---------- base de datos ----------
function makeDb(env) {
  if (env.NEON_FETCH_ENDPOINT) neonConfig.fetchEndpoint = env.NEON_FETCH_ENDPOINT;  // solo para pruebas locales
  const sql = neon(env.DATABASE_URL, { fullResults: false });
  const q = (text, params = []) => sql.query(text, params);
  return {
    all: q,
    one: async (text, params) => (await q(text, params))[0] || null,
    run: q,
    tx: (list) => sql.transaction(list.map(([t, p]) => sql.query(t, p || []))),
  };
}

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  const r = await db.one("SELECT to_regclass('public.quotes') IS NOT NULL AS ok");
  if (!r.ok) await db.tx(SCHEMA.map((s) => [s]));
  schemaReady = true;
}

// ---------- utilidades ----------
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
function toB64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64.replace(/\s+/g, '')); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

async function hashPin(pin, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(saltHex), iterations: PBKDF2_ITER }, key, 256);
  return toB64(bits);
}
async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
    "connect-src 'self'; frame-src 'self' blob:; object-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra },
  });
}
const err = (msg, status = 400) => json({ error: msg }, status);

function withSec(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SEC_HEADERS)) r.headers.set(k, v);
  return r;
}

function cookie(req, name) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
function sessionCookie(token, maxAge) {
  return `cot_s=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const validPin = (p) => typeof p === 'string' && /^\d{4}$/.test(p);
const validName = (n) => typeof n === 'string' && n.trim().length >= 2 && n.trim().length <= 40;

// Mismo cálculo que en el navegador: precios unitarios netos, IVA sobre el neto con descuento.
function computeTotals(items, discountType, discountValue, ivaRate) {
  const subtotal = items.reduce((s, it) => s + Math.round(num(it.qty) * num(it.price)), 0);
  let discount = discountType === 'amt'
    ? Math.round(num(discountValue))
    : Math.round(subtotal * Math.min(Math.max(num(discountValue), 0), 100) / 100);
  discount = Math.min(Math.max(discount, 0), subtotal);
  const net = subtotal - discount;
  const iva = Math.round(net * ivaRate / 100);
  return { subtotal, discount, net, iva, total: net + iva };
}

function sanitizeQuote(b) {
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 200).map((it) => ({
    qty: Math.max(0, num(it.qty)),
    desc: str(it.desc, 2000),
    price: Math.max(0, Math.round(num(it.price))),
  })).filter((it) => it.desc || it.qty || it.price);
  const discountType = b.discountType === 'amt' ? 'amt' : 'pct';
  const discountValue = Math.max(0, num(b.discountValue));
  const ivaRate = Math.min(Math.max(num(b.ivaRate ?? IVA_DEFAULT), 0), 100);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : new Date().toISOString().slice(0, 10);
  return {
    client: {
      company: str(b.client?.company, 150), contact: str(b.client?.contact, 150), rut: str(b.client?.rut, 20),
      phone: str(b.client?.phone, 40), email: str(b.client?.email, 150), address: str(b.client?.address, 300),
    },
    date, validDays: Math.min(Math.max(Math.round(num(b.validDays) || 15), 1), 365),
    items, discountType, discountValue, ivaRate, notes: str(b.notes, 4000),
    totals: computeTotals(items, discountType, discountValue, ivaRate),
  };
}

function rowToQuote(r, full = false) {
  const q = {
    id: r.id, number: r.number, date: r.quote_date, total: Number(r.total), hasPdf: r.pdf_size > 0, pdfSize: r.pdf_size,
    client: { company: r.client_company, contact: r.client_contact, rut: r.client_rut, phone: r.client_phone, email: r.client_email, address: r.client_address },
  };
  if (full) Object.assign(q, {
    validDays: r.valid_days, items: JSON.parse(r.items_json || '[]'), discountType: r.discount_type,
    discountValue: Number(r.discount_value), ivaRate: Number(r.iva_rate), notes: r.notes,
    totals: { subtotal: Number(r.subtotal), discount: Number(r.discount_amount), net: Number(r.net), iva: Number(r.iva), total: Number(r.total) },
  });
  return q;
}

async function readJson(req) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_JSON) throw new Error('too_big');
  const t = await req.text();
  if (t.length > MAX_JSON) throw new Error('too_big');
  return t ? JSON.parse(t) : {};
}

// ---------- sesión ----------
async function currentUser(req, db) {
  const t = cookie(req, 'cot_s');
  if (!t || !/^[a-f0-9]{64}$/.test(t)) return null;
  const row = await db.one(
    'SELECT u.id, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1', [await sha256(t)]);
  if (!row || Number(row.expires_at) < Date.now()) return null;
  return { id: row.id, name: row.name };
}

async function createSession(db, userId) {
  const token = randomHex(32);
  await db.tx([
    ['DELETE FROM sessions WHERE expires_at < $1', [Date.now()]],
    ['INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [await sha256(token), userId, Date.now() + SESSION_DAYS * 864e5]],
  ]);
  return sessionCookie(token, SESSION_DAYS * 86400);
}

// Bloqueo: 5 intentos fallidos por nombre+IP → 15 min; 10 por nombre (cualquier IP) → 1 hora.
async function checkLock(db, keys) {
  const now = Date.now();
  const rows = await db.all('SELECT locked_until FROM login_attempts WHERE k = ANY($1::text[])', [keys]);
  const until = Math.max(0, ...rows.map((r) => Number(r.locked_until)));
  return until > now ? Math.ceil((until - now) / 60000) : 0;
}
async function registerFail(db, k, limit, lockMs) {
  const r = await db.one('SELECT fails FROM login_attempts WHERE k = $1', [k]);
  const fails = (r?.fails || 0) + 1;
  const locked = fails >= limit;
  await db.run(
    `INSERT INTO login_attempts (k, fails, locked_until) VALUES ($1, $2, $3)
     ON CONFLICT (k) DO UPDATE SET fails = EXCLUDED.fails, locked_until = EXCLUDED.locked_until`,
    [k, locked ? 0 : fails, locked ? Date.now() + lockMs : 0]);
}

const userCount = async (db) => (await db.one('SELECT COUNT(*)::int AS n FROM users')).n;

// ---------- API ----------
async function api(req, env, url) {
  if (!env.DATABASE_URL) return err('Falta la variable DATABASE_URL (conexión de Neon) en Cloudflare.', 500);
  const db = makeDb(env);
  await ensureSchema(db);

  const path = url.pathname.replace(/^\/api/, '');
  const method = req.method;

  // Protección CSRF: toda escritura debe venir de esta misma página.
  if (method !== 'GET' && req.headers.get('X-Cotizador') !== '1') return err('Solicitud no válida', 403);

  if (path === '/status' && method === 'GET') {
    const n = await userCount(db);
    const user = await currentUser(req, db);
    return json({ needsSetup: n === 0, setupEnabled: !!env.SETUP_KEY, user });
  }

  if (path === '/setup' && method === 'POST') {
    const b = await readJson(req);
    if (await userCount(db) > 0) return err('La cuenta inicial ya existe.', 409);
    if (!env.SETUP_KEY) return err('Falta la variable SETUP_KEY en Cloudflare.', 500);
    const ip = req.headers.get('CF-Connecting-IP') || 'x';
    const mins = await checkLock(db, ['setup:' + ip]);
    if (mins) return err(`Demasiados intentos. Espera ${mins} min.`, 429);
    if (!safeEqual(await sha256(String(b.setupKey || '')), await sha256(env.SETUP_KEY))) {
      await registerFail(db, 'setup:' + ip, 5, 15 * 60000);
      return err('La clave de instalación no es correcta.', 401);
    }
    if (!validName(b.name) || !validPin(b.pin)) return err('Nombre (2 a 40 letras) y PIN de 4 números.');
    const salt = randomHex(16);
    const r = await db.one('INSERT INTO users (name, pin_hash, salt) VALUES ($1, $2, $3) RETURNING id',
      [b.name.trim(), await hashPin(b.pin, salt), salt]);
    return json({ ok: true, user: { id: r.id, name: b.name.trim() } }, 200, { 'Set-Cookie': await createSession(db, r.id) });
  }

  if (path === '/login' && method === 'POST') {
    const b = await readJson(req);
    const name = str(b.name, 40).toLowerCase();
    if (!name || !validPin(b.pin)) return err('Escribe tu nombre y un PIN de 4 números.');
    const ip = req.headers.get('CF-Connecting-IP') || 'x';
    const kIp = `ip:${ip}:${name}`, kName = `name:${name}`;
    const mins = await checkLock(db, [kIp, kName]);
    if (mins) return err(`Demasiados intentos. Espera ${mins} min.`, 429);
    const u = await db.one('SELECT id, name, pin_hash, salt FROM users WHERE lower(name) = $1', [name]);
    const h = await hashPin(b.pin, u ? u.salt : 'nouser-salt');
    if (!u || !safeEqual(h, u.pin_hash)) {
      await registerFail(db, kIp, 5, 15 * 60000);
      await registerFail(db, kName, 10, 60 * 60000);
      return err('Nombre o PIN incorrecto.', 401);
    }
    await db.run('DELETE FROM login_attempts WHERE k = ANY($1::text[])', [[kIp, kName]]);
    return json({ ok: true, user: { id: u.id, name: u.name } }, 200, { 'Set-Cookie': await createSession(db, u.id) });
  }

  if (path === '/logout' && method === 'POST') {
    const t = cookie(req, 'cot_s');
    if (t) await db.run('DELETE FROM sessions WHERE token_hash = $1', [await sha256(t)]);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  // ----- desde aquí, todo requiere sesión -----
  const user = await currentUser(req, db);
  if (!user) return err('Sesión expirada. Vuelve a entrar.', 401);

  if (path === '/settings') {
    if (method === 'GET') {
      const r = await db.one("SELECT v FROM settings WHERE k = 'company'");
      return json(r ? JSON.parse(r.v) : {});
    }
    if (method === 'PUT') {
      const b = await readJson(req);
      const logo = typeof b.logo === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(b.logo) && b.logo.length < 900_000 ? b.logo : '';
      const s = {
        tradeName: str(b.tradeName, 100), legalName: str(b.legalName, 150), rut: str(b.rut, 20), giro: str(b.giro, 200),
        address: str(b.address, 300), phone: str(b.phone, 60), email: str(b.email, 150), web: str(b.web, 150),
        seller: str(b.seller, 100), bank: str(b.bank, 1000), conditions: str(b.conditions, 3000),
        ivaRate: Math.min(Math.max(num(b.ivaRate ?? IVA_DEFAULT), 0), 100), validDays: Math.round(num(b.validDays) || 15), logo, configured: true,
      };
      await db.run("INSERT INTO settings (k, v) VALUES ('company', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(s)]);
      return json({ ok: true });
    }
  }

  if (path === '/pin' && method === 'POST') {
    const b = await readJson(req);
    if (!validPin(b.current) || !validPin(b.next)) return err('Los PIN deben tener 4 números.');
    const u = await db.one('SELECT pin_hash, salt FROM users WHERE id = $1', [user.id]);
    if (!safeEqual(await hashPin(b.current, u.salt), u.pin_hash)) return err('El PIN actual no es correcto.', 401);
    const salt = randomHex(16);
    await db.run('UPDATE users SET pin_hash = $1, salt = $2 WHERE id = $3', [await hashPin(b.next, salt), salt, user.id]);
    return json({ ok: true });
  }

  if (path === '/users') {
    if (method === 'GET') {
      return json(await db.all('SELECT id, name, created_at::text AS created_at FROM users ORDER BY id'));
    }
    if (method === 'POST') {
      const b = await readJson(req);
      if (!validName(b.name) || !validPin(b.pin)) return err('Nombre (2 a 40 letras) y PIN de 4 números.');
      const exists = await db.one('SELECT id FROM users WHERE lower(name) = lower($1)', [b.name.trim()]);
      if (exists) return err('Ya existe una cuenta con ese nombre.', 409);
      const salt = randomHex(16);
      await db.run('INSERT INTO users (name, pin_hash, salt) VALUES ($1, $2, $3)', [b.name.trim(), await hashPin(b.pin, salt), salt]);
      return json({ ok: true });
    }
  }
  let m = path.match(/^\/users\/(\d+)$/);
  if (m && method === 'DELETE') {
    const id = Number(m[1]);
    if (id === user.id) return err('No puedes borrar tu propia cuenta.');
    await db.run('DELETE FROM users WHERE id = $1', [id]);   // sus sesiones se borran solas (ON DELETE CASCADE)
    return json({ ok: true });
  }

  const QUOTE_COLS = `id, number, client_company, client_contact, client_rut, client_phone, client_email, client_address,
    quote_date, valid_days, items_json, discount_type, discount_value, iva_rate, notes,
    subtotal, discount_amount, net, iva, total, pdf_size`;

  if (path === '/quotes') {
    if (method === 'GET') {
      const q = str(url.searchParams.get('q') || '', 100);
      const cols = 'id, number, client_company, client_contact, client_rut, client_phone, client_email, client_address, quote_date, total, pdf_size';
      let rows;
      if (q) {
        const like = '%' + q.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
        const numQ = /^\d{1,9}$/.test(q) ? Number(q) : -1;
        rows = await db.all(
          `SELECT ${cols} FROM quotes
           WHERE client_company ILIKE $1 OR client_contact ILIKE $1 OR client_rut ILIKE $1 OR number = $2
           ORDER BY number DESC LIMIT 200`, [like, numQ]);
      } else {
        rows = await db.all(`SELECT ${cols} FROM quotes ORDER BY number DESC LIMIT 200`);
      }
      return json(rows.map((x) => rowToQuote(x)));
    }
    if (method === 'POST') {
      const s = sanitizeQuote(await readJson(req));
      const r = await db.one(
        `INSERT INTO quotes (number, client_company, client_contact, client_rut, client_phone, client_email, client_address,
           quote_date, valid_days, items_json, discount_type, discount_value, iva_rate, notes,
           subtotal, discount_amount, net, iva, total, created_by)
         VALUES ((SELECT COALESCE(MAX(number), 0) + 1 FROM quotes), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING id, number`,
        [s.client.company, s.client.contact, s.client.rut, s.client.phone, s.client.email, s.client.address,
          s.date, s.validDays, JSON.stringify(s.items), s.discountType, s.discountValue, s.ivaRate, s.notes,
          s.totals.subtotal, s.totals.discount, s.totals.net, s.totals.iva, s.totals.total, user.id]);
      return json({ id: r.id, number: r.number, totals: s.totals });
    }
  }

  m = path.match(/^\/quotes\/(\d+)(\/pdf)?$/);
  if (m) {
    const id = Number(m[1]);
    if (m[2]) {
      if (method === 'GET') {
        const r = await db.one("SELECT number, encode(pdf, 'base64') AS pdf_b64 FROM quotes WHERE id = $1", [id]);
        if (!r || !r.pdf_b64) return err('Esta cotización no tiene PDF guardado.', 404);
        const fname = `Cotizacion-${String(r.number).padStart(4, '0')}.pdf`;
        const dl = url.searchParams.get('dl') === '1';
        return new Response(fromB64(r.pdf_b64), { headers: {
          'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store',
          'Content-Disposition': `${dl ? 'attachment' : 'inline'}; filename="${fname}"`, ...SEC_HEADERS,
          'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'",
          'X-Frame-Options': 'SAMEORIGIN',
        } });
      }
      if (method === 'PUT') {
        const len = Number(req.headers.get('Content-Length') || 0);
        if (len > MAX_PDF) return err('El PDF pesa demasiado (máx. 1,9 MB). Usa una imagen más liviana.', 413);
        const buf = await req.arrayBuffer();
        if (buf.byteLength > MAX_PDF) return err('El PDF pesa demasiado (máx. 1,9 MB). Usa una imagen más liviana.', 413);
        if (new TextDecoder().decode(buf.slice(0, 5)) !== '%PDF-') return err('El archivo no es un PDF.');
        const r = await db.one(
          "UPDATE quotes SET pdf = decode($1, 'base64'), pdf_size = $2, updated_at = now() WHERE id = $3 RETURNING id",
          [toB64(buf), buf.byteLength, id]);
        if (!r) return err('No existe esa cotización.', 404);
        return json({ ok: true, size: buf.byteLength });
      }
    }
    if (method === 'GET') {
      const r = await db.one(`SELECT ${QUOTE_COLS} FROM quotes WHERE id = $1`, [id]);
      if (!r) return err('No existe esa cotización.', 404);
      return json(rowToQuote(r, true));
    }
    if (method === 'PUT') {
      const s = sanitizeQuote(await readJson(req));
      const r = await db.one(
        `UPDATE quotes SET client_company=$1, client_contact=$2, client_rut=$3, client_phone=$4, client_email=$5, client_address=$6,
           quote_date=$7, valid_days=$8, items_json=$9, discount_type=$10, discount_value=$11, iva_rate=$12, notes=$13,
           subtotal=$14, discount_amount=$15, net=$16, iva=$17, total=$18, updated_at=now() WHERE id=$19 RETURNING id, number`,
        [s.client.company, s.client.contact, s.client.rut, s.client.phone, s.client.email, s.client.address,
          s.date, s.validDays, JSON.stringify(s.items), s.discountType, s.discountValue, s.ivaRate, s.notes,
          s.totals.subtotal, s.totals.discount, s.totals.net, s.totals.iva, s.totals.total, id]);
      if (!r) return err('No existe esa cotización.', 404);
      return json({ id: r.id, number: r.number, totals: s.totals });
    }
    if (method === 'DELETE') {
      await db.run('DELETE FROM quotes WHERE id = $1', [id]);
      return json({ ok: true });
    }
  }

  return err('No encontrado', 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(req, env, url); }
      catch (e) {
        if (e && e.message === 'too_big') return err('Los datos pesan demasiado.', 413);
        if (e instanceof SyntaxError) return err('Datos mal formados.');
        console.error(e);
        return err('Error del servidor o de conexión con la base de datos. Intenta de nuevo.', 500);
      }
    }
    if (url.pathname.startsWith('/_')) return new Response('No encontrado', { status: 404 });
    return withSec(await env.ASSETS.fetch(req));
  },
};
