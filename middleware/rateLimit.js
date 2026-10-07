// Small in-memory rate limiter for the auth endpoints (brute-force protection).
// Counts live per server instance; good enough to blunt password guessing.
const buckets = new Map();

function prune(now) {
  if (buckets.size < 5000) return;
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
}

// rateLimit({ name, max, windowMs, key }) — key(req) adds e.g. the email to the bucket key.
function rateLimit({ name, max, windowMs, key }) {
  return (req, res, next) => {
    const now = Date.now();
    prune(now);
    const id = `${name}:${clientIp(req)}:${key ? key(req) : ''}`;
    let b = buckets.get(id);
    if (!b || b.reset <= now) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(id, b);
    }
    b.count += 1;
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - b.count));
    if (b.count > max) {
      const wait = Math.ceil((b.reset - now) / 60000);
      res.setHeader('Retry-After', Math.ceil((b.reset - now) / 1000));
      return res.status(429).json({ error: `Too many attempts. Please wait ${wait} minute${wait === 1 ? '' : 's'} and try again.` });
    }
    next();
  };
}

const emailKey = (req) => String(req.body?.email || '').trim().toLowerCase();

// Per-IP limits are generous because a whole classroom (or a proxy) can share one
// IP; the per-email limits are what actually stop password guessing.
module.exports = {
  rateLimit,
  loginLimit:      rateLimit({ name: 'login',       max: 300, windowMs: 15 * 60 * 1000 }),
  loginEmailLimit: rateLimit({ name: 'login-email', max: 15,  windowMs: 15 * 60 * 1000, key: emailKey }),
  registerLimit:   rateLimit({ name: 'register',    max: 100, windowMs: 60 * 60 * 1000 }),
  forgotLimit:     rateLimit({ name: 'forgot',      max: 5,   windowMs: 15 * 60 * 1000, key: emailKey }),
  resetLimit:      rateLimit({ name: 'reset',       max: 60,  windowMs: 15 * 60 * 1000 }),
};
