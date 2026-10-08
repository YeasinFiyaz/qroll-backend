// Rate limiting for the auth endpoints (brute-force protection).
//
// Per-email counters live in the database so they work on serverless hosts
// where every request may land on a different instance. Per-IP counters are
// in-memory and deliberately generous (a whole classroom can share one IP).
const crypto = require('crypto');
const db = require('../db');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.query(`CREATE TABLE IF NOT EXISTS auth_attempts (
    key_hash     CHAR(64) PRIMARY KEY,
    attempts     INT NOT NULL DEFAULT 0,
    window_start DATETIME NOT NULL
  )`);
  tableReady = true;
}

// Returns { blocked, retryAfterSec } for key, counting this call as an attempt.
async function hit(name, key, max, windowSec) {
  await ensureTable();
  const k = sha(`${name}:${key}`);
  // Start a new window when the old one has expired, otherwise bump the counter.
  await db.query(
    `INSERT INTO auth_attempts (key_hash, attempts, window_start) VALUES (?, 1, NOW())
     ON DUPLICATE KEY UPDATE
       attempts = IF(window_start < DATE_SUB(NOW(), INTERVAL ? SECOND), 1, attempts + 1),
       window_start = IF(window_start < DATE_SUB(NOW(), INTERVAL ? SECOND), NOW(), window_start)`,
    [k, windowSec, windowSec]
  );
  const [[row]] = await db.query(
    'SELECT attempts, TIMESTAMPDIFF(SECOND, NOW(), DATE_ADD(window_start, INTERVAL ? SECOND)) AS left_sec FROM auth_attempts WHERE key_hash = ?',
    [windowSec, k]
  );
  // Occasionally sweep stale rows so the table never grows unbounded.
  if (Math.random() < 0.02) db.query('DELETE FROM auth_attempts WHERE window_start < DATE_SUB(NOW(), INTERVAL 1 DAY)').catch(() => {});
  return { blocked: row.attempts > max, retryAfterSec: Math.max(1, row.left_sec || 0), attempts: row.attempts };
}

async function clear(name, key) {
  await ensureTable();
  await db.query('DELETE FROM auth_attempts WHERE key_hash = ?', [sha(`${name}:${key}`)]);
}

function tooMany(res, retryAfterSec) {
  const mins = Math.ceil(retryAfterSec / 60);
  res.setHeader('Retry-After', retryAfterSec);
  return res.status(429).json({ error: `Too many attempts. Please wait ${mins} minute${mins === 1 ? '' : 's'} and try again.` });
}

// Database-backed limiter keyed by a request value (e.g. the email).
function dbLimit({ name, max, windowSec, key }) {
  return async (req, res, next) => {
    const k = key(req);
    if (!k) return next();
    try {
      const r = await hit(name, k, max, windowSec);
      if (r.blocked) return tooMany(res, r.retryAfterSec);
    } catch (err) {
      console.error('rate limit check failed:', err.message); // never block login because of the limiter itself
    }
    next();
  };
}

// In-memory limiter keyed by client IP (soft, per instance).
const buckets = new Map();
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
}
function ipLimit({ name, max, windowMs }) {
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 5000) for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
    const id = `${name}:${clientIp(req)}`;
    let b = buckets.get(id);
    if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(id, b); }
    b.count += 1;
    if (b.count > max) return tooMany(res, Math.ceil((b.reset - now) / 1000));
    next();
  };
}

const emailKey = (req) => String(req.body?.email || '').trim().toLowerCase();

module.exports = {
  // 15 failed/any login attempts per email per 15 minutes (cleared on success)
  loginEmailLimit: dbLimit({ name: 'login', max: 15, windowSec: 15 * 60, key: emailKey }),
  clearLoginLimit: (email) => clear('login', String(email).trim().toLowerCase()).catch(() => {}),
  forgotLimit:     dbLimit({ name: 'forgot', max: 5, windowSec: 15 * 60, key: emailKey }),
  loginLimit:      ipLimit({ name: 'login',    max: 300, windowMs: 15 * 60 * 1000 }),
  registerLimit:   ipLimit({ name: 'register', max: 100, windowMs: 60 * 60 * 1000 }),
  resetLimit:      ipLimit({ name: 'reset',    max: 60,  windowMs: 15 * 60 * 1000 }),
};
