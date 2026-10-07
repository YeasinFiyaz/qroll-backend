const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { adminOnly } = authMiddleware;

router.use(authMiddleware, adminOnly);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(['student', 'teacher', 'admin']);

// ---------- overview ----------
router.get('/overview', async (req, res) => {
  const tz = Math.max(-840, Math.min(840, Number(req.query.tz) || 0));
  const [[counts]] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE role = 'student') AS students,
       (SELECT COUNT(*) FROM users WHERE role = 'teacher') AS teachers,
       (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admins,
       (SELECT COUNT(*) FROM courses) AS courses,
       (SELECT COUNT(*) FROM sessions) AS sessions,
       (SELECT COUNT(*) FROM sessions WHERE is_active = 1 AND expires_at > NOW()) AS live_sessions,
       (SELECT COUNT(*) FROM attendances) AS attendances,
       (SELECT COUNT(*) FROM attendances
          WHERE DATE(DATE_ADD(marked_at, INTERVAL ? MINUTE)) = DATE(DATE_ADD(NOW(), INTERVAL ? MINUTE))) AS scans_today,
       (SELECT COUNT(*) FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS new_users_week`,
    [tz, tz]
  );
  const [recentUsers] = await db.query(
    'SELECT user_id, name, email, role, created_at FROM users ORDER BY created_at DESC LIMIT 8'
  );
  const [recentSessions] = await db.query(
    `SELECT s.session_id, s.created_at, s.expires_at, (s.is_active = 1 AND s.expires_at > NOW()) AS is_live,
       c.course_code, c.course_name, u.name AS teacher_name,
       (SELECT COUNT(*) FROM attendances a WHERE a.session_id = s.session_id) AS present_count,
       (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = s.course_id) AS enrolled_count
     FROM sessions s JOIN courses c ON c.course_id = s.course_id JOIN users u ON u.user_id = c.teacher_id
     ORDER BY s.created_at DESC LIMIT 8`
  );
  res.json({ ...counts, recentUsers, recentSessions });
});

// ---------- users ----------
router.get('/users', async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.role && ROLES.has(req.query.role)) { where.push('u.role = ?'); params.push(req.query.role); }
  if (req.query.q) { where.push('(u.name LIKE ? OR u.email LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const [rows] = await db.query(
    `SELECT u.user_id, u.name, u.email, u.role, u.created_at,
       (SELECT COUNT(*) FROM courses c WHERE c.teacher_id = u.user_id) AS course_count,
       (SELECT COUNT(*) FROM enrollments e WHERE e.student_id = u.user_id) AS enrolled_count,
       (SELECT COUNT(*) FROM attendances a WHERE a.student_id = u.user_id) AS attendance_count
     FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY FIELD(u.role, 'admin', 'teacher', 'student'), u.name
     LIMIT 1000`,
    params
  );
  res.json(rows);
});

router.get('/teachers', async (req, res) => {
  const [rows] = await db.query(
    "SELECT user_id, name, email FROM users WHERE role IN ('teacher', 'admin') ORDER BY name"
  );
  res.json(rows);
});

router.post('/users', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = ROLES.has(req.body.role) ? req.body.role : 'student';
  if (name.length < 2) return res.status(400).json({ error: 'Please enter a full name' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [name, email, hash, role]
    );
    res.status(201).json({ message: `${role} account created for ${name}`, user_id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'An account with this email already exists' });
    throw err;
  }
});

router.put('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const [rows] = await db.query('SELECT * FROM users WHERE user_id = ?', [id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const name = req.body.name !== undefined ? String(req.body.name).trim() : user.name;
  const email = req.body.email !== undefined ? String(req.body.email).trim().toLowerCase() : user.email;
  const role = req.body.role !== undefined ? req.body.role : user.role;
  if (name.length < 2) return res.status(400).json({ error: 'Please enter a full name' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email' });
  if (!ROLES.has(role)) return res.status(400).json({ error: 'Invalid role' });
  if (id === req.user.user_id && role !== 'admin') {
    return res.status(400).json({ error: 'You cannot remove your own admin role' });
  }
  // A teacher who still owns courses can't be turned into a student.
  if (user.role !== 'student' && role === 'student') {
    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM courses WHERE teacher_id = ?', [id]);
    if (n > 0) return res.status(400).json({ error: `This user still owns ${n} course(s). Reassign or delete them first.` });
  }

  const sets = ['name = ?', 'email = ?', 'role = ?'];
  const params = [name, email, role];
  if (req.body.password) {
    if (String(req.body.password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    sets.push('password_hash = ?');
    params.push(await bcrypt.hash(String(req.body.password), 10));
  }
  params.push(id);
  try {
    await db.query(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ?`, params);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Another account already uses this email' });
    throw err;
  }
  res.json({ message: 'User updated' });
});

// Removes a user and everything that belongs to them (inside a transaction).
async function deleteUserCascade(q, id) {
  // As a student
  const [att] = await q('DELETE FROM attendances WHERE student_id = ?', [id]);
  await q('DELETE FROM enrollments WHERE student_id = ?', [id]);
  // As a teacher: their courses and everything under them
  await q('DELETE a FROM attendances a JOIN sessions s ON s.session_id = a.session_id JOIN courses c ON c.course_id = s.course_id WHERE c.teacher_id = ?', [id]);
  await q('DELETE s FROM sessions s JOIN courses c ON c.course_id = s.course_id WHERE c.teacher_id = ?', [id]);
  await q('DELETE e FROM enrollments e JOIN courses c ON c.course_id = e.course_id WHERE c.teacher_id = ?', [id]);
  const [courses] = await q('DELETE FROM courses WHERE teacher_id = ?', [id]);
  await q('DELETE FROM password_resets WHERE user_id = ?', [id]).catch(() => {});
  await q('DELETE FROM users WHERE user_id = ?', [id]);
  return { attendances: att.affectedRows, courses: courses.affectedRows };
}

router.delete('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.user_id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const [rows] = await db.query('SELECT * FROM users WHERE user_id = ?', [id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const removed = await db.transaction((q) => deleteUserCascade(q, id));
  res.json({ message: `${user.name} deleted`, ...removed });
});

// Delete several users at once (e.g. cleaning up test accounts).
router.post('/users/bulk-delete', async (req, res) => {
  const ids = [...new Set((req.body?.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    .filter((id) => id !== req.user.user_id);
  if (ids.length === 0) return res.status(400).json({ error: 'No users selected' });
  if (ids.length > 200) return res.status(400).json({ error: 'Select at most 200 users at a time' });
  const totals = await db.transaction(async (q) => {
    let users = 0, courses = 0, attendances = 0;
    for (const id of ids) {
      const [rows] = await q('SELECT user_id FROM users WHERE user_id = ?', [id]);
      if (!rows[0]) continue;
      const r = await deleteUserCascade(q, id);
      users += 1; courses += r.courses; attendances += r.attendances;
    }
    return { users, courses, attendances };
  });
  res.json({ message: `${totals.users} user(s) deleted (with ${totals.courses} course(s))`, ...totals });
});

// ---------- courses ----------
router.get('/courses', async (req, res) => {
  const [rows] = await db.query(
    `SELECT c.*, u.name AS teacher_name, u.email AS teacher_email,
       (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.course_id) AS student_count,
       (SELECT COUNT(*) FROM sessions s WHERE s.course_id = c.course_id) AS session_count,
       (SELECT MAX(s.created_at) FROM sessions s WHERE s.course_id = c.course_id) AS last_session_at
     FROM courses c JOIN users u ON u.user_id = c.teacher_id
     ORDER BY c.created_at DESC`
  );
  res.json(rows);
});

router.post('/courses', async (req, res) => {
  const course_name = String(req.body.course_name || '').trim();
  const course_code = String(req.body.course_code || '').trim().toUpperCase();
  const teacher_id = Number(req.body.teacher_id);
  if (!course_name || !course_code) return res.status(400).json({ error: 'Course name and code are required' });
  const [t] = await db.query("SELECT user_id FROM users WHERE user_id = ? AND role IN ('teacher', 'admin')", [teacher_id]);
  if (!t[0]) return res.status(400).json({ error: 'Please choose a teacher' });
  try {
    const [result] = await db.query(
      'INSERT INTO courses (course_name, course_code, teacher_id) VALUES (?, ?, ?)',
      [course_name, course_code, teacher_id]
    );
    res.status(201).json({ message: 'Course created', course_id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'This course code already exists' });
    throw err;
  }
});

// Reassign a course to another teacher (and/or rename it)
router.put('/courses/:id', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM courses WHERE course_id = ?', [req.params.id]);
  const course = rows[0];
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const course_name = String(req.body.course_name || course.course_name).trim();
  const course_code = String(req.body.course_code || course.course_code).trim().toUpperCase();
  const teacher_id = Number(req.body.teacher_id || course.teacher_id);
  const [t] = await db.query("SELECT user_id FROM users WHERE user_id = ? AND role IN ('teacher', 'admin')", [teacher_id]);
  if (!t[0]) return res.status(400).json({ error: 'Please choose a teacher' });
  try {
    await db.query(
      'UPDATE courses SET course_name = ?, course_code = ?, teacher_id = ? WHERE course_id = ?',
      [course_name, course_code, teacher_id, course.course_id]
    );
    res.json({ message: 'Course updated' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'This course code already exists' });
    throw err;
  }
});

module.exports = router;
