const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');

// MARK ATTENDANCE — student scans QR
router.post('/scan', authMiddleware, async (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Only students can mark attendance' });
  }
  const { token, lat, lng } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    // Step 1: Validate token
    const [sessions] = await db.query(
      'SELECT * FROM sessions WHERE token = ? AND is_active = 1 AND expires_at > NOW()',
      [token]
    );
    if (sessions.length === 0) {
      return res.status(410).json({ error: 'Session expired or invalid' });
    }
    const session = sessions[0];

    // Step 2: Insert attendance (DB unique constraint handles duplicates)
    try {
      await db.query(
        'INSERT INTO attendances (session_id, student_id, lat, lng) VALUES (?, ?, ?, ?)',
        [session.session_id, req.user.user_id, lat || null, lng || null]
      );
      res.json({ message: 'Attendance marked successfully!' });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Attendance already marked for this session' });
      }
      throw err;
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET MY ATTENDANCE HISTORY — student
router.get('/my-history', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT a.marked_at, s.session_id, c.course_name, c.course_code
       FROM attendances a
       JOIN sessions s ON a.session_id = s.session_id
       JOIN courses c ON s.course_id = c.course_id
       WHERE a.student_id = ?
       ORDER BY a.marked_at DESC`,
      [req.user.user_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET ALL STUDENTS IN A SESSION — teacher
router.get('/session/:id', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.name, u.email, a.marked_at
       FROM attendances a
       JOIN users u ON a.student_id = u.user_id
       WHERE a.session_id = ?
       ORDER BY a.marked_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;