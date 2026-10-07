const db = require('../db');

// Every switch the admin can flip. `true` = visible / allowed.
const DEFAULT_FEATURES = {
  // Teacher dashboard sections
  'teacher.stats': true,
  'teacher.running_sessions': true,
  'teacher.start_attendance': true,
  'teacher.recent_sessions': true,
  'teacher.my_courses': true,
  'teacher.needs_attention': true,
  // Teacher pages
  'teacher.page_courses': true,
  'teacher.page_reports': true,
  'teacher.can_create_course': true,
  'teacher.can_delete_course': true,
  'teacher.can_email_alerts': true,
  // Student home sections
  'student.overall': true,
  'student.my_courses': true,
  'student.recent_checkins': true,
  'student.low_warning': true,
  // Student pages
  'student.page_scan': true,
  'student.page_history': true,
  // Site-wide
  'global.registration': true,
  'global.registration_teacher': true,
};

const FEATURE_LABELS = {
  'teacher.stats': 'Stats cards (courses, students, sessions, averages)',
  'teacher.running_sessions': 'Running sessions panel',
  'teacher.start_attendance': 'Start attendance panel',
  'teacher.recent_sessions': 'Recent sessions table',
  'teacher.my_courses': 'My courses panel',
  'teacher.needs_attention': 'Needs attention (low attendance) panel',
  'teacher.page_courses': 'Courses page',
  'teacher.page_reports': 'Reports page',
  'teacher.can_create_course': 'Teachers can create courses',
  'teacher.can_delete_course': 'Teachers can delete their courses',
  'teacher.can_email_alerts': 'Teachers can send low-attendance emails',
  'student.overall': 'Overall attendance ring',
  'student.my_courses': 'My courses list',
  'student.recent_checkins': 'Recent check-ins panel',
  'student.low_warning': 'Low attendance warning banner',
  'student.page_scan': 'Scan page (students can mark attendance)',
  'student.page_history': 'History page',
  'global.registration': 'Anyone can create an account',
  'global.registration_teacher': 'Sign-up form offers the Teacher role',
};

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await db.query(`CREATE TABLE IF NOT EXISTS settings (
    setting_key VARCHAR(64) PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  ensured = true;
}

async function getSetting(key, fallback) {
  await ensureTable();
  const [rows] = await db.query('SELECT value FROM settings WHERE setting_key = ?', [key]);
  if (!rows[0]) return fallback;
  try { return JSON.parse(rows[0].value); } catch (e) { return fallback; }
}

async function setSetting(key, value) {
  await ensureTable();
  await db.query(
    'INSERT INTO settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [key, JSON.stringify(value)]
  );
}

// Stored overrides merged over the defaults, so new switches appear automatically.
async function getFeatures() {
  const stored = await getSetting('features', {});
  const out = { ...DEFAULT_FEATURES };
  for (const k of Object.keys(DEFAULT_FEATURES)) {
    if (typeof stored[k] === 'boolean') out[k] = stored[k];
  }
  return out;
}

async function updateFeatures(patch) {
  const current = await getFeatures();
  for (const [k, v] of Object.entries(patch || {})) {
    if (k in DEFAULT_FEATURES && typeof v === 'boolean') current[k] = v;
  }
  await setSetting('features', current);
  return current;
}

// Express helper: 403 unless the switch is on (admins bypass every switch).
function requireFeature(key) {
  return async (req, res, next) => {
    if (req.user?.role === 'admin') return next();
    const features = await getFeatures();
    if (!features[key]) {
      return res.status(403).json({ error: 'This feature has been turned off by the administrator' });
    }
    next();
  };
}

module.exports = { DEFAULT_FEATURES, FEATURE_LABELS, getFeatures, updateFeatures, requireFeature, getSetting, setSetting };
