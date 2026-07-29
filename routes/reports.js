const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');

// GET ATTENDANCE REPORT FOR A COURSE
router.get('/course/:id', authMiddleware, async (req, res) => {
  const { from, to } = req.query;
  try {
    const [rows] = await db.query(
      `SELECT
        u.user_id, u.name, u.email,
        COUNT(DISTINCT s.session_id) AS total_sessions,
        COUNT(DISTINCT a.session_id) AS attended_sessions,
        ROUND(COUNT(DISTINCT a.session_id) * 100.0 /
          NULLIF(COUNT(DISTINCT s.session_id), 0), 2) AS percentage
       FROM enrollments e
       JOIN users u ON u.user_id = e.student_id
       JOIN sessions s ON s.course_id = e.course_id
       LEFT JOIN attendances a
              ON a.session_id = s.session_id
             AND a.student_id = e.student_id
       WHERE e.course_id = ?
         AND s.created_at BETWEEN ? AND ?
       GROUP BY e.student_id
       ORDER BY percentage ASC`,
      [req.params.id, from || '2000-01-01', to || '2100-01-01']
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET STUDENT SUMMARY ACROSS ALL COURSES
router.get('/student/:id/summary', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
        c.course_name, c.course_code,
        COUNT(DISTINCT s.session_id) AS total_sessions,
        COUNT(DISTINCT a.session_id) AS attended_sessions,
        ROUND(COUNT(DISTINCT a.session_id) * 100.0 /
          NULLIF(COUNT(DISTINCT s.session_id), 0), 2) AS percentage
       FROM enrollments e
       JOIN courses c ON c.course_id = e.course_id
       JOIN sessions s ON s.course_id = e.course_id
       LEFT JOIN attendances a
              ON a.session_id = s.session_id
             AND a.student_id = e.student_id
       WHERE e.student_id = ?
       GROUP BY c.course_id
       ORDER BY percentage ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET LOW ATTENDANCE STUDENTS (below 75%)
router.get('/low-attendance', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
        u.name, u.email, c.course_name,
        COUNT(DISTINCT s.session_id) AS total_sessions,
        COUNT(DISTINCT a.session_id) AS attended_sessions,
        ROUND(COUNT(DISTINCT a.session_id) * 100.0 /
          NULLIF(COUNT(DISTINCT s.session_id), 0), 2) AS percentage
       FROM enrollments e
       JOIN users u ON u.user_id = e.student_id
       JOIN courses c ON c.course_id = e.course_id
       JOIN sessions s ON s.course_id = e.course_id
       LEFT JOIN attendances a
              ON a.session_id = s.session_id
             AND a.student_id = e.student_id
       GROUP BY e.student_id, e.course_id
       HAVING percentage < 75
       ORDER BY percentage ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});
const { sendLowAttendanceAlert } = require('../utils/mailer');

// SEND LOW ATTENDANCE EMAIL ALERTS
router.post('/send-alerts/:course_id', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
        u.name, u.email, c.course_name,
        COUNT(DISTINCT s.session_id) AS total_sessions,
        COUNT(DISTINCT a.session_id) AS attended_sessions,
        ROUND(COUNT(DISTINCT a.session_id) * 100.0 /
          NULLIF(COUNT(DISTINCT s.session_id), 0), 2) AS percentage
       FROM enrollments e
       JOIN users u ON u.user_id = e.student_id
       JOIN courses c ON c.course_id = e.course_id
       JOIN sessions s ON s.course_id = e.course_id
       LEFT JOIN attendances a
              ON a.session_id = s.session_id
             AND a.student_id = e.student_id
       WHERE e.course_id = ?
       GROUP BY e.student_id
       HAVING percentage < 75`,
      [req.params.course_id]
    );

    if (rows.length === 0) {
      return res.json({ message: 'No students below 75% — no alerts sent!' });
    }

    let sent = 0;
    for (const student of rows) {
      await sendLowAttendanceAlert(
        student.email,
        student.name,
        student.course_name,
        student.percentage
      );
      sent++;
    }

    res.json({ message: `Alerts sent to ${sent} student(s) successfully!` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send alerts' });
  }
});



module.exports = router;