const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { getFeatures } = require('../utils/settings');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Accounts whose email is listed in ADMIN_EMAILS become admins automatically
// (on register and on every login), so no password ever has to be shared.
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
);
const isBootstrapAdmin = (email) => ADMIN_EMAILS.has(String(email).toLowerCase());

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
  const features = await getFeatures();
  const bootstrapAdmin = isBootstrapAdmin(email);

  if (!features['global.registration'] && !bootstrapAdmin) {
    return res.status(403).json({ error: 'Sign-up is currently closed. Please contact the administrator.' });
  }
  // Admin accounts can't be self-created from the public sign-up form.
  let role = req.body.role === 'teacher' ? 'teacher' : 'student';
  if (role === 'teacher' && !features['global.registration_teacher'] && !bootstrapAdmin) {
    return res.status(403).json({ error: 'Teacher sign-up is closed. Ask the administrator to create your account.' });
  }
  if (bootstrapAdmin) role = 'admin';

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
  if (user.role !== 'admin' && isBootstrapAdmin(user.email)) {
    await db.query("UPDATE users SET role = 'admin' WHERE user_id = ?", [user.user_id]);
    user.role = 'admin';
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

// CURRENT USER — lets the frontend confirm a stored token is still valid
router.get('/me', authMiddleware, async (req, res) => {
  const [rows] = await db.query('SELECT * FROM users WHERE user_id = ?', [req.user.user_id]);
  if (!rows[0]) return res.status(401).json({ error: 'Account not found' });
  // Role may have changed (e.g. promoted by an admin): hand back a fresh token too.
  const user = rows[0];
  res.json({ user: publicUser(user), token: user.role !== req.user.role ? signToken(user) : undefined });
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
