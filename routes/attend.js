const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { teacherOnly, studentOnly } = authMiddleware;
const { ownedSession } = require('../utils/ownership');

// Accepts the raw token or a full scan URL (…/scan?t=TOKEN) pasted by the student.
function extractToken(input) {
  const value = String(input || '').trim();
  const match = value.match(/[?&]t=([a-f0-9]+)/i);
  return (match ? match[1] : value).toLowerCase();
}

function coord(value, limit) {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

// MARK ATTENDANCE — student scans QR
router.post('/scan', authMiddleware, studentOnly, async (req, res) => {
  const token = extractToken(req.body.token);
  if (!token) return res.status(400).json({ error: 'Session code is required' });

  const [sessions] = await db.query(
    `SELECT s.*, c.course_name, c.course_code,
       (s.is_active = 1 AND s.expires_at > NOW()) AS is_live
     FROM sessions s JOIN courses c ON c.course_id = s.course_id
     WHERE s.token = ?`,
    [token]
  );
  const session = sessions[0];
  if (!session) return res.status(404).json({ error: 'Invalid QR code / session code' });
  if (!session.is_live) {
    return res.status(410).json({ error: 'This attendance session has ended. Ask your teacher to start a new one.' });
  }

  // A student scanning the class QR is joined to the course automatically,
  // so attendance always shows up in the teacher's reports.
  await db.query(
    'INSERT IGNORE INTO enrollments (student_id, course_id) VALUES (?, ?)',
    [req.user.user_id, session.course_id]
  );

  try {
    await db.query(
      'INSERT INTO attendances (session_id, student_id, lat, lng) VALUES (?, ?, ?, ?)',
      [session.session_id, req.user.user_id, coord(req.body.lat, 90), coord(req.body.lng, 180)]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: `You are already marked present for ${session.course_code}`,
        course_name: session.course_name, course_code: session.course_code,
      });
    }
    throw err;
  }
  res.json({
    message: `Attendance marked for ${session.course_name} (${session.course_code})`,
    course_name: session.course_name,
    course_code: session.course_code,
    marked_at: new Date().toISOString(),
  });
});

// MY ATTENDANCE HISTORY — student
router.get('/my-history', authMiddleware, async (req, res) => {
  const [rows] = await db.query(
    `SELECT a.marked_at, s.session_id, c.course_id, c.course_name, c.course_code
     FROM attendances a
     JOIN sessions s ON a.session_id = s.session_id
     JOIN courses c ON s.course_id = c.course_id
     WHERE a.student_id = ?
     ORDER BY a.marked_at DESC
     LIMIT 500`,
    [req.user.user_id]
  );
  res.json(rows);
});

// ALL STUDENTS IN A SESSION — teacher (present + absent)
router.get('/session/:id', authMiddleware, teacherOnly, async (req, res) => {
  const session = await ownedSession(req.user, req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const [rows] = await db.query(
    `SELECT u.user_id, u.name, u.email, a.marked_at
     FROM enrollments e
     JOIN users u ON u.user_id = e.student_id
     LEFT JOIN attendances a ON a.student_id = e.student_id AND a.session_id = ?
     WHERE e.course_id = ?
     UNION
     SELECT u.user_id, u.name, u.email, a.marked_at
     FROM attendances a JOIN users u ON u.user_id = a.student_id
     WHERE a.session_id = ?
     ORDER BY name`,
    [session.session_id, session.course_id, session.session_id]
  );
  res.json({
    session: {
      session_id: session.session_id,
      course_name: session.course_name,
      course_code: session.course_code,
      created_at: session.created_at,
      expires_at: session.expires_at,
    },
    students: rows.map((r) => ({ ...r, present: !!r.marked_at })),
  });
});

module.exports = router;
