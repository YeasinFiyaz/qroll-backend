const mysql = require('mysql2/promise');
require('dotenv').config();

const useSSL = String(process.env.DB_SSL || '').toLowerCase() === 'true';

const pool = mysql.createPool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl:      useSSL ? { minVersion: 'TLSv1.2', rejectUnauthorized: false } : undefined,
  // Small pool + keep-alive: free MySQL hosts drop idle sockets, which used to
  // surface as random "Server error" on login after the app sat unused.
  connectionLimit:       Number(process.env.DB_POOL_SIZE) || 5,
  maxIdle:               2,
  idleTimeout:           60000,
  enableKeepAlive:       true,
  keepAliveInitialDelay: 10000,
  connectTimeout:        15000,
  waitForConnections:    true,
  // Everything is stored and compared in UTC so session expiry works no matter
  // where the server or the database is hosted.
  timezone: 'Z',
  dateStrings: false,
});

pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

// Retry once on dropped-connection errors so a stale socket never reaches the user.
const RETRYABLE = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED']);
const rawQuery = pool.query.bind(pool);
pool.query = async (...args) => {
  try {
    return await rawQuery(...args);
  } catch (err) {
    if (RETRYABLE.has(err.code)) return rawQuery(...args);
    throw err;
  }
};

module.exports = pool;
