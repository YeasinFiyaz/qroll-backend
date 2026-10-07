const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { teacherOnly } = authMiddleware;
const { ownedCourse, ownedSession } = require('../utils/ownership');

// A session is live while it is open AND not past its expiry. This is checked on
// every read, so no background timer is needed (works on serverless hosts too).
const LIVE_SQL = '(s.is_active = 1 AND s.expires_at > NOW())';

function frontendBase() {
  const first = (process.env.FRONTEND_URL || process.env.BASE_URL || '').split(',')[0].trim();
  return first.replace(/\/$/, '');
}

// START SESSION — teacher only
router.post('/start', authMiddleware, teacherOnly, async (req, res) => {
  const course_id = Number(req.body.course_id);
  const expiry_minutes = Number(req.body.expiry_minutes);
  if (!course_id || !expiry_minutes) {
    return res.status(400).json({ error: 'Please choose a course and a duration' });
  }
  if (expiry_minutes < 1 || expiry_minutes > 180) {
    return res.status(400).json({ error: 'Duration must be between 1 and 180 minutes' });
  }
  const course = await ownedCourse(req.user, course_id);
  if (!course) return res.status(404).json({ error: 'Course not found' });

  const token = crypto.randomBytes(16).toString('hex');
  const [result] = await db.query(
    'INSERT INTO sessions (course_id, token, expires_at, is_active) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), 1)',
    [course.course_id, token, expiry_minutes]
  );
  const [[row]] = await db.query(
    'SELECT expires_at, created_at, NOW() AS server_now FROM sessions WHERE session_id = ?',
    [result.insertId]
  );

  const scanURL = `${frontendBase()}/scan?t=${token}`;
  const qrImage = await QRCode.toDataURL(scanURL, { width: 400, margin: 1 });

  res.status(201).json({
    session_id: result.insertId,
    course_id: course.course_id,
    course_name: course.course_name,
    course_code: course.course_code,
    token,
    qrImage,
    expires_at: row.expires_at,
    created_at: row.created_at,
    server_now: row.server_now,
    scan_url: scanURL,
  });
});

// ACTIVE SESSIONS of this teacher — lets the dashboard resume after a refresh
router.get('/active', authMiddleware, teacherOnly, async (req, res) => {
  const all = req.user.role === 'admin';
  const [rows] = await db.query(
    `SELECT s.session_id, s.course_id, s.token, s.expires_at, s.created_at,
       c.course_name, c.course_code, NOW() AS server_now,
       (SELECT COUNT(*) FROM attendances a WHERE a.session_id = s.session_id) AS present_count
     FROM sessions s JOIN courses c ON c.course_id = s.course_id
     WHERE ${all ? '1=1' : 'c.teacher_id = ?'} AND ${LIVE_SQL}
     ORDER BY s.created_at DESC`,
    all ? [] : [req.user.user_id]
  );
  res.json(rows);
});

// SESSION HISTORY
router.get('/history', authMiddleware, teacherOnly, async (req, res) => {
  const all = req.user.role === 'admin';
  const params = all ? [] : [req.user.user_id];
  let courseFilter = '';
  if (req.query.course_id) {
    courseFilter = 'AND s.course_id = ?';
    params.push(req.query.course_id);
  }
  const [rows] = await db.query(
    `SELECT s.session_id, s.course_id, s.expires_at, s.created_at,
       ${LIVE_SQL} AS is_live, s.is_active,
       c.course_name, c.course_code,
       (SELECT COUNT(*) FROM attendances a WHERE a.session_id = s.session_id) AS present_count,
       (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = s.course_id) AS enrolled_count
     FROM sessions s
     JOIN courses c ON s.course_id = c.course_id
     WHERE ${all ? '1=1' : 'c.teacher_id = ?'} ${courseFilter}
     ORDER BY s.created_at DESC
     LIMIT 200`,
    params
  );
  res.json(rows);
});

// CLOSE SESSION MANUALLY
router.put('/:id/close', authMiddleware, teacherOnly, async (req, res) => {
  const session = await ownedSession(req.user, req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  await db.query('UPDATE sessions SET is_active = 0 WHERE session_id = ?', [session.session_id]);
  res.json({ message: 'Session closed successfully' });
});

// LIVE COUNT + who has scanned so far
router.get('/:id/live', authMiddleware, teacherOnly, async (req, res) => {
  const session = await ownedSession(req.user, req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const [students] = await db.query(
    `SELECT u.user_id, u.name, u.email, a.marked_at
     FROM attendances a JOIN users u ON u.user_id = a.student_id
     WHERE a.session_id = ?
     ORDER BY a.marked_at DESC`,
    [session.session_id]
  );
  const [[state]] = await db.query(
    `SELECT ${LIVE_SQL} AS is_live, s.expires_at, NOW() AS server_now,
       (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = s.course_id) AS enrolled_count
     FROM sessions s WHERE s.session_id = ?`,
    [session.session_id]
  );
  res.json({
    count: students.length,
    students,
    is_live: !!state.is_live,
    expires_at: state.expires_at,
    server_now: state.server_now,
    enrolled_count: state.enrolled_count,
  });
});

module.exports = router;
