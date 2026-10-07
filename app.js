const express = require('express');
const cors = require('cors');
require('dotenv').config();

const db = require('./db');

const app = express();
app.set('trust proxy', 1);

// Allow the deployed frontend(s) plus localhost. FRONTEND_URL may hold several
// comma-separated origins. Any *.vercel.app preview of this project is allowed too.
const allowed = (process.env.FRONTEND_URL || '')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowed.length === 0) return cb(null, true);
    if (allowed.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)
        || /^https:\/\/qroll-frontend[\w-]*\.vercel\.app$/.test(origin)) {
      return cb(null, true);
    }
    return cb(null, false);
  },
}));
app.use(express.json({ limit: '100kb' }));
app.use(db.requestScope);

app.get('/', (req, res) => {
  res.json({ message: 'QRoll API is running!' });
});

// Health check for UptimeRobot: also touches the database so it stays warm.
const health = async (req, res) => {
  const started = Date.now();
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', ms: Date.now() - started, time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'down', error: err.code || err.message });
  }
};
app.get('/health', health);
app.get('/api/v1/health', health);

app.use('/api/v1/auth',     require('./routes/auth'));
app.use('/api/v1/sessions', require('./routes/sessions'));
app.use('/api/v1/attend',   require('./routes/attend'));
app.use('/api/v1/reports',  require('./routes/reports'));
app.use('/api/v1/courses',  require('./routes/courses'));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Express 5 forwards rejected promises from async handlers here.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  res.status(500).json({ error: 'Server error, please try again' });
});

module.exports = app;
