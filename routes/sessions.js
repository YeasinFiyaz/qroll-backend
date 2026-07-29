const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const QRCode = require('qrcode');
const cron = require('node-cron');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

// Auto-expire sessions every 60 seconds
cron.schedule('* * * * *', async () => {
  await db.query(
    'UPDATE sessions SET is_active = 0 WHERE expires_at < NOW() AND is_active = 1'
  );
});

// START SESSION — teacher only
router.post('/start', authMiddleware, async (req, res) => {
  if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only teachers can start sessions' });
  }
  const { course_id, expiry_minutes } = req.body;
  if (!course_id || !expiry_minutes) {
    return res.status(400).json({ error: 'course_id and expiry_minutes are required' });
  }
  if (expiry_minutes < 2 || expiry_minutes > 30) {
    return res.status(400).json({ error: 'expiry_minutes must be between 2 and 30' });
  }
  try {
    const token = crypto.randomBytes(16).toString('hex');
    const expires_at = new Date(Date.now() + expiry_minutes * 60000);
    const scanURL = `${process.env.BASE_URL}/scan?t=${token}`;
    const qrImage = await QRCode.toDataURL(scanURL);

    const [result] = await db.query(
      'INSERT INTO sessions (course_id, token, expires_at, is_active) VALUES (?, ?, ?, 1)',
      [course_id, token, expires_at]
    );
    res.status(201).json({
      session_id: result.insertId,
      token,
      qrImage,
      expires_at,
      scan_url: scanURL
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// CLOSE SESSION MANUALLY
router.put('/:id/close', authMiddleware, async (req, res) => {
  try {
    await db.query(
      'UPDATE sessions SET is_active = 0 WHERE session_id = ?',
      [req.params.id]
    );
    res.json({ message: 'Session closed successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET LIVE COUNT
router.get('/:id/live', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT COUNT(*) as count FROM attendances WHERE session_id = ?',
      [req.params.id]
    );
    res.json({ count: rows[0].count });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET SESSION HISTORY
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT s.*, c.course_name, c.course_code 
       FROM sessions s 
       JOIN courses c ON s.course_id = c.course_id 
       WHERE c.teacher_id = ? 
       ORDER BY s.created_at DESC`,
      [req.user.user_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;