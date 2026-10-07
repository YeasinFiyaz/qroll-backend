const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config();

const useSSL = String(process.env.DB_SSL || '').toLowerCase() === 'true';
// On Vercel every request may run in its own short-lived instance, so connections
// are opened per request and closed before the response is sent. Elsewhere
// (Render, local) a long-lived pool is used.
const serverless = !!process.env.VERCEL || process.env.DB_MODE === 'per-request';

const config = {
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl:      useSSL ? { minVersion: 'TLSv1.2', rejectUnauthorized: false } : undefined,
  connectTimeout: 15000,
  // Everything is stored and compared in UTC so session expiry works no matter
  // where the server or the database is hosted.
  timezone: 'Z',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Free MySQL hosts allow very few simultaneous connections (often 5 per user).
const LIMIT_ERRORS = new Set(['ER_USER_LIMIT_REACHED', 'ER_CON_COUNT_ERROR', 'ER_TOO_MANY_USER_CONNECTIONS']);
const RETRYABLE = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED']);

// ---------- long-lived pool (Render / local) ----------
const pool = mysql.createPool({
  ...config,
  // Small pool + keep-alive: free MySQL hosts drop idle sockets, which used to
  // surface as random "Server error" on login after the app sat unused.
  connectionLimit:       Number(process.env.DB_POOL_SIZE) || 4,
  maxIdle:               1,
  idleTimeout:           30000,
  enableKeepAlive:       true,
  keepAliveInitialDelay: 10000,
  waitForConnections:    true,
});

pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

async function poolQuery(...args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await pool.query(...args);
    } catch (err) {
      const limited = LIMIT_ERRORS.has(err.code);
      if ((limited && attempt < 8) || (RETRYABLE.has(err.code) && attempt < 1)) {
        await sleep(Math.min(200 * 2 ** attempt, 2000) + Math.random() * 150);
        continue;
      }
      throw err;
    }
  }
}

// ---------- per-request connections (Vercel) ----------
// Cap simultaneous connections from one instance; extra requests wait their turn.
const MAX_OPEN = Number(process.env.DB_MAX_OPEN) || 2;
let open = 0;
const waiting = [];
async function acquireSlot() {
  if (open < MAX_OPEN) { open += 1; return; }
  await new Promise((resolve) => waiting.push(resolve));
}
function releaseSlot() {
  const next = waiting.shift();
  if (next) next(); else open -= 1;
}

async function connect() {
  await acquireSlot();
  for (let attempt = 0; ; attempt++) {
    try {
      const conn = await mysql.createConnection(config);
      await conn.query("SET time_zone = '+00:00'");
      return conn;
    } catch (err) {
      if ((LIMIT_ERRORS.has(err.code) && attempt < 10) || (RETRYABLE.has(err.code) && attempt < 2)) {
        await sleep(Math.min(200 * 2 ** attempt, 2000) + Math.random() * 200);
        continue;
      }
      releaseSlot();
      throw err;
    }
  }
}

async function close(conn) {
  try {
    await conn.end();
  } catch (e) {
    conn.destroy();
  } finally {
    releaseSlot();
  }
}

const scope = new AsyncLocalStorage();

async function scopedQuery(...args) {
  const store = scope.getStore();
  if (!store) {
    // Outside a request (scripts): one connection per query.
    const conn = await connect();
    try { return await conn.query(...args); } finally { await close(conn); }
  }
  if (!store.conn) store.conn = connect();
  const conn = await store.conn;
  return conn.query(...args);
}

// Express middleware: one DB connection per request, closed before the response
// leaves, so a frozen serverless instance never keeps a connection hanging.
function requestScope(req, res, next) {
  if (!serverless) return next();
  const store = { conn: null };
  let finished = false;
  const originalEnd = res.end;
  res.end = function end(...args) {
    if (finished || !store.conn) {
      finished = true;
      return originalEnd.apply(this, args);
    }
    finished = true;
    const pending = store.conn;
    store.conn = null;
    pending.then(close, () => {}).finally(() => originalEnd.apply(this, args));
    return this;
  };
  res.on('close', () => {
    if (!finished && store.conn) {
      store.conn.then((c) => { c.destroy(); releaseSlot(); }, () => {});
      store.conn = null;
    }
  });
  scope.run(store, next);
}

const db = {
  query: (...args) => (serverless ? scopedQuery(...args) : poolQuery(...args)),
  end: () => pool.end(),
  requestScope,
  serverless,
};

module.exports = db;
