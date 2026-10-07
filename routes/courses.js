const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { teacherOnly, studentOnly } = authMiddleware;
const { ownedCourse } = require('../utils/ownership');

// CREATE COURSE
router.post('/create', authMiddleware, teacherOnly, async (req, res) => {
  const course_name = String(req.body.course_name || '').trim();
  const course_code = String(req.body.course_code || '').trim().toUpperCase();
  if (!course_name || !course_code) {
    return res.status(400).json({ error: 'Course name and course code are required' });
  }
  try {
    const [result] = await db.query(
      'INSERT INTO courses (course_name, course_code, teacher_id) VALUES (?, ?, ?)',
      [course_name, course_code, req.user.user_id]
    );
    res.status(201).json({ message: 'Course created!', course_id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'This course code already exists' });
    }
    throw err;
  }
});

// GET MY COURSES (teacher) — with student and session counts
router.get('/my-courses', authMiddleware, teacherOnly, async (req, res) => {
  const [rows] = await db.query(
    `SELECT c.*,
       (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.course_id) AS student_count,
       (SELECT COUNT(*) FROM sessions s WHERE s.course_id = c.course_id) AS session_count,
       (SELECT MAX(s.created_at) FROM sessions s WHERE s.course_id = c.course_id) AS last_session_at
     FROM courses c
     WHERE c.teacher_id = ?
     ORDER BY c.created_at DESC`,
    [req.user.user_id]
  );
  res.json(rows);
});

// GET MY ENROLLED COURSES (student) — with attendance percentage
router.get('/enrolled', authMiddleware, studentOnly, async (req, res) => {
  const [rows] = await db.query(
    `SELECT c.course_id, c.course_name, c.course_code, u.name AS teacher_name,
       COUNT(DISTINCT s.session_id) AS total_sessions,
       COUNT(DISTINCT a.session_id) AS attended_sessions,
       ROUND(COUNT(DISTINCT a.session_id) * 100.0 /
         NULLIF(COUNT(DISTINCT s.session_id), 0), 2) AS percentage
     FROM enrollments e
     JOIN courses c ON c.course_id = e.course_id
     JOIN users u ON u.user_id = c.teacher_id
     LEFT JOIN sessions s ON s.course_id = c.course_id
     LEFT JOIN attendances a ON a.session_id = s.session_id AND a.student_id = e.student_id
     WHERE e.student_id = ?
     GROUP BY c.course_id, c.course_name, c.course_code, u.name
     ORDER BY c.course_name`,
    [req.user.user_id]
  );
  res.json(rows);
});

// ENROLL STUDENT(S) INTO COURSE — accepts one email or many (comma / newline separated)
router.post('/enroll', authMiddleware, teacherOnly, async (req, res) => {
  const { course_id } = req.body;
  const course = await ownedCourse(req.user, course_id);
  if (!course) return res.status(404).json({ error: 'Course not found' });

  const emails = [...new Set(
    String(req.body.student_email || req.body.student_emails || '')
      .split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
  )];
  if (emails.length === 0) return res.status(400).json({ error: 'Enter at least one student email' });

  const enrolled = [], already = [], notFound = [];
  for (const email of emails) {
    const [users] = await db.query(
      "SELECT user_id, name FROM users WHERE LOWER(email) = ? AND role = 'student'",
      [email]
    );
    if (users.length === 0) { notFound.push(email); continue; }
    try {
      await db.query(
        'INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)',
        [users[0].user_id, course.course_id]
      );
      enrolled.push(users[0].name);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') { already.push(users[0].name); continue; }
      throw err;
    }
  }

  if (emails.length === 1) {
    if (enrolled.length) return res.json({ message: `${enrolled[0]} enrolled successfully!`, enrolled, already, notFound });
    if (already.length) return res.status(400).json({ error: `${already[0]} is already enrolled`, enrolled, already, notFound });
    return res.status(404).json({ error: 'No student account found with that email. Ask the student to register first.', enrolled, already, notFound });
  }

  const parts = [];
  if (enrolled.length) parts.push(`${enrolled.length} enrolled`);
  if (already.length) parts.push(`${already.length} already enrolled`);
  if (notFound.length) parts.push(`${notFound.length} not found`);
  res.json({ message: parts.join(', '), enrolled, already, notFound });
});

// GET ENROLLED STUDENTS FOR A COURSE — with each student's attendance
router.get('/:id/students', authMiddleware, teacherOnly, async (req, res) => {
  const course = await ownedCourse(req.user, req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const [rows] = await db.query(
    `SELECT u.user_id, u.name, u.email,
       COUNT(DISTINCT s.session_id) AS total_sessions,
       COUNT(DISTINCT a.session_id) AS attended_sessions,
       ROUND(COUNT(DISTINCT a.session_id) * 100.0 /
         NULLIF(COUNT(DISTINCT s.session_id), 0), 2) AS percentage
     FROM enrollments e
     JOIN users u ON u.user_id = e.student_id
     LEFT JOIN sessions s ON s.course_id = e.course_id
     LEFT JOIN attendances a ON a.session_id = s.session_id AND a.student_id = e.student_id
     WHERE e.course_id = ?
     GROUP BY u.user_id, u.name, u.email
     ORDER BY u.name`,
    [course.course_id]
  );
  res.json(rows);
});

// REMOVE A STUDENT FROM A COURSE (their past attendance records are kept)
router.delete('/:id/students/:studentId', authMiddleware, teacherOnly, async (req, res) => {
  const course = await ownedCourse(req.user, req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const [result] = await db.query(
    'DELETE FROM enrollments WHERE course_id = ? AND student_id = ?',
    [course.course_id, req.params.studentId]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Student is not enrolled' });
  res.json({ message: 'Student removed from course' });
});

// UPDATE COURSE NAME / CODE
router.put('/:id', authMiddleware, teacherOnly, async (req, res) => {
  const course = await ownedCourse(req.user, req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const course_name = String(req.body.course_name || course.course_name).trim();
  const course_code = String(req.body.course_code || course.course_code).trim().toUpperCase();
  try {
    await db.query(
      'UPDATE courses SET course_name = ?, course_code = ? WHERE course_id = ?',
      [course_name, course_code, course.course_id]
    );
    res.json({ message: 'Course updated' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'This course code already exists' });
    throw err;
  }
});

module.exports = router;
