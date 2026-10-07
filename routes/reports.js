const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { teacherOnly } = authMiddleware;
const { ownedCourse } = require('../utils/ownership');
const { sendLowAttendanceAlert, mailerConfigured } = require('../utils/mailer');

const THRESHOLD = Number(process.env.LOW_ATTENDANCE_THRESHOLD) || 75;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Per-student attendance for one course. Sessions are filtered by date inside the
// JOIN so students with zero sessions in range still appear.
// `from`/`to` are calendar days (YYYY-MM-DD, interpreted in UTC). The frontend also
// sends from_ts/to_ts — exact instants for the viewer's local midnight — which win.
function toSqlUtc(value) {
  const d = new Date(value);
  return value && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 19).replace('T', ' ') : null;
}

function rangeBounds(q) {
  const start = toSqlUtc(q.from_ts) || (DATE_RE.test(q.from || '') ? `${q.from} 00:00:00` : '2000-01-01 00:00:00');
  let end = toSqlUtc(q.to_ts);
  if (!end) {
    const day = DATE_RE.test(q.to || '') ? q.to : '2100-01-01';
    end = new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 19).replace('T', ' ');
  }
  return [start, end];
}

async function courseReport(courseId, query = {}) {
  const [start, end] = rangeBounds(query);
  const [rows] = await db.query(
    `SELECT
       u.user_id, u.name, u.email, c.course_name, c.course_code,
       COUNT(DISTINCT s.session_id) AS total_sessions,
       COUNT(DISTINCT a.session_id) AS attended_sessions,
       ROUND(COUNT(DISTINCT a.session_id) * 100.0 /
         NULLIF(COUNT(DISTINCT s.session_id), 0), 2) AS percentage,
       MAX(a.marked_at) AS last_attended
     FROM enrollments e
     JOIN users u ON u.user_id = e.student_id
     JOIN courses c ON c.course_id = e.course_id
     LEFT JOIN sessions s ON s.course_id = e.course_id
            AND s.created_at >= ? AND s.created_at < ?
     LEFT JOIN attendances a ON a.session_id = s.session_id AND a.student_id = e.student_id
     WHERE e.course_id = ?
     GROUP BY u.user_id, u.name, u.email, c.course_name, c.course_code
     ORDER BY percentage ASC, u.name ASC`,
    [start, end, courseId]
  );
  return rows;
}

// TEACHER OVERVIEW — numbers for the dashboard cards
router.get('/overview', authMiddleware, teacherOnly, async (req, res) => {
  const uid = req.user.user_id;
  // "Today" in the viewer's timezone: tz = minutes east of UTC (e.g. 360 for Dhaka).
  const tz = Math.max(-840, Math.min(840, Number(req.query.tz) || 0));
  const [[totals]] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM courses WHERE teacher_id = ?) AS courses,
       (SELECT COUNT(DISTINCT e.student_id) FROM enrollments e
          JOIN courses c ON c.course_id = e.course_id WHERE c.teacher_id = ?) AS students,
       (SELECT COUNT(*) FROM sessions s
          JOIN courses c ON c.course_id = s.course_id WHERE c.teacher_id = ?) AS sessions,
       (SELECT COUNT(*) FROM attendances a JOIN sessions s ON s.session_id = a.session_id
          JOIN courses c ON c.course_id = s.course_id
          WHERE c.teacher_id = ?
            AND DATE(DATE_ADD(a.marked_at, INTERVAL ? MINUTE)) = DATE(DATE_ADD(NOW(), INTERVAL ? MINUTE))) AS scans_today`,
    [uid, uid, uid, uid, tz, tz]
  );
  const [[avg]] = await db.query(
    `SELECT ROUND(AVG(pct), 1) AS avg_attendance FROM (
       SELECT COUNT(DISTINCT a.session_id) * 100.0 / NULLIF(COUNT(DISTINCT s.session_id), 0) AS pct
       FROM enrollments e
       JOIN courses c ON c.course_id = e.course_id
       JOIN sessions s ON s.course_id = e.course_id
       LEFT JOIN attendances a ON a.session_id = s.session_id AND a.student_id = e.student_id
       WHERE c.teacher_id = ?
       GROUP BY e.student_id, e.course_id
     ) t`,
    [uid]
  );
  res.json({ ...totals, avg_attendance: avg.avg_attendance, threshold: THRESHOLD });
});

// ATTENDANCE REPORT FOR A COURSE
router.get('/course/:id', authMiddleware, teacherOnly, async (req, res) => {
  const course = await ownedCourse(req.user, req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  res.json(await courseReport(course.course_id, req.query));
});

// SESSION-BY-SESSION BREAKDOWN FOR A COURSE
router.get('/course/:id/sessions', authMiddleware, teacherOnly, async (req, res) => {
  const course = await ownedCourse(req.user, req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const [rows] = await db.query(
    `SELECT s.session_id, s.created_at, s.expires_at,
       (s.is_active = 1 AND s.expires_at > NOW()) AS is_live,
       (SELECT COUNT(*) FROM attendances a WHERE a.session_id = s.session_id) AS present_count,
       (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = s.course_id) AS enrolled_count
     FROM sessions s WHERE s.course_id = ?
     ORDER BY s.created_at DESC`,
    [course.course_id]
  );
  res.json(rows);
});

// MY SUMMARY — student, across all enrolled courses
async function studentSummary(studentId) {
  const [rows] = await db.query(
    `SELECT
       c.course_id, c.course_name, c.course_code,
       COUNT(DISTINCT s.session_id) AS total_sessions,
       COUNT(DISTINCT a.session_id) AS attended_sessions,
       ROUND(COUNT(DISTINCT a.session_id) * 100.0 /
         NULLIF(COUNT(DISTINCT s.session_id), 0), 2) AS percentage
     FROM enrollments e
     JOIN courses c ON c.course_id = e.course_id
     LEFT JOIN sessions s ON s.course_id = e.course_id
     LEFT JOIN attendances a ON a.session_id = s.session_id AND a.student_id = e.student_id
     WHERE e.student_id = ?
     GROUP BY c.course_id, c.course_name, c.course_code
     ORDER BY c.course_name`,
    [studentId]
  );
  return rows;
}

router.get('/me/summary', authMiddleware, async (req, res) => {
  res.json(await studentSummary(req.user.user_id));
});

// Kept for compatibility: a student may read only their own summary.
router.get('/student/:id/summary', authMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  if (req.user.role === 'student' && id !== req.user.user_id) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  res.json(await studentSummary(id));
});

// LOW ATTENDANCE STUDENTS across this teacher's courses
router.get('/low-attendance', authMiddleware, teacherOnly, async (req, res) => {
  const [rows] = await db.query(
    `SELECT
       u.name, u.email, c.course_id, c.course_name, c.course_code,
       COUNT(DISTINCT s.session_id) AS total_sessions,
       COUNT(DISTINCT a.session_id) AS attended_sessions,
       ROUND(COUNT(DISTINCT a.session_id) * 100.0 /
         NULLIF(COUNT(DISTINCT s.session_id), 0), 2) AS percentage
     FROM enrollments e
     JOIN users u ON u.user_id = e.student_id
     JOIN courses c ON c.course_id = e.course_id
     JOIN sessions s ON s.course_id = e.course_id
     LEFT JOIN attendances a ON a.session_id = s.session_id AND a.student_id = e.student_id
     WHERE c.teacher_id = ?
     GROUP BY e.student_id, e.course_id, u.name, u.email, c.course_id, c.course_name, c.course_code
     HAVING percentage < ?
     ORDER BY percentage ASC`,
    [req.user.user_id, THRESHOLD]
  );
  res.json(rows);
});

// SEND LOW ATTENDANCE EMAIL ALERTS
router.post('/send-alerts/:course_id', authMiddleware, teacherOnly, async (req, res) => {
  const course = await ownedCourse(req.user, req.params.course_id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  if (!mailerConfigured()) {
    return res.status(503).json({ error: 'Email is not set up on the server (EMAIL_USER / EMAIL_PASS missing)' });
  }

  const rows = (await courseReport(course.course_id))
    .filter((r) => r.total_sessions > 0 && Number(r.percentage) < THRESHOLD);
  if (rows.length === 0) {
    return res.json({ message: `No students below ${THRESHOLD}% — no alerts needed!`, sent: 0 });
  }

  const results = await Promise.allSettled(rows.map((s) =>
    sendLowAttendanceAlert(s.email, s.name, s.course_name, s.percentage, THRESHOLD)
  ));
  const sent = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - sent;
  results.filter((r) => r.status === 'rejected').forEach((r) => console.error('Mail failed:', r.reason?.message));

  if (sent === 0) return res.status(502).json({ error: 'Could not send emails. Check the email settings on the server.' });
  res.json({
    message: `Alerts sent to ${sent} student(s)${failed ? `, ${failed} failed` : ''}.`,
    sent, failed,
  });
});

module.exports = router;
