const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  return { id: u.user_id, name: u.name, email: u.email, role: u.role };
}

function signToken(user) {
  return jwt.sign(
    { user_id: user.user_id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// REGISTER
router.post('/register', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  // Admin accounts can't be self-created from the public sign-up form.
  const role = req.body.role === 'teacher' ? 'teacher' : 'student';

  if (name.length < 2) return res.status(400).json({ error: 'Please enter your full name' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [name, email, hash, role]
    );
    const user = { user_id: result.insertId, name, email, role };
    res.status(201).json({
      message: 'Account created successfully',
      user_id: result.insertId,
      token: signToken(user),
      user: publicUser(user),
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }
    throw err;
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const [rows] = await db.query('SELECT * FROM users WHERE LOWER(email) = ?', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

// CURRENT USER — lets the frontend confirm a stored token is still valid
router.get('/me', authMiddleware, async (req, res) => {
  const [rows] = await db.query('SELECT * FROM users WHERE user_id = ?', [req.user.user_id]);
  if (!rows[0]) return res.status(401).json({ error: 'Account not found' });
  res.json({ user: publicUser(rows[0]) });
});

// CHANGE PASSWORD
router.put('/password', authMiddleware, async (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const [rows] = await db.query('SELECT * FROM users WHERE user_id = ?', [req.user.user_id]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(current, user.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const hash = await bcrypt.hash(next, 10);
  await db.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, user.user_id]);
  res.json({ message: 'Password updated successfully' });
});

module.exports = router;
