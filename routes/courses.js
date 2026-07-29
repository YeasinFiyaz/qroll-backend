const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');

// CREATE COURSE
router.post('/create', authMiddleware, async (req, res) => {
  if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only teachers can create courses' });
  }
  const { course_name, course_code } = req.body;
  if (!course_name || !course_code) {
    return res.status(400).json({ error: 'course_name and course_code are required' });
  }
  try {
    const [result] = await db.query(
      'INSERT INTO courses (course_name, course_code, teacher_id) VALUES (?, ?, ?)',
      [course_name, course_code, req.user.user_id]
    );
    res.status(201).json({ message: 'Course created!', course_id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Course code already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// GET MY COURSES
router.get('/my-courses', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM courses WHERE teacher_id = ? ORDER BY created_at DESC',
      [req.user.user_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ENROLL STUDENT INTO COURSE
router.post('/enroll', authMiddleware, async (req, res) => {
  const { student_email, course_id } = req.body;
  try {
    const [users] = await db.query(
      'SELECT * FROM users WHERE email = ? AND role = "student"',
      [student_email]
    );
    if (users.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    const student = users[0];
    await db.query(
      'INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)',
      [student.user_id, course_id]
    );
    res.json({ message: `${student.name} enrolled successfully!` });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Student already enrolled' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// GET ENROLLED STUDENTS FOR A COURSE
router.get('/:id/students', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.user_id, u.name, u.email 
       FROM enrollments e
       JOIN users u ON u.user_id = e.student_id
       WHERE e.course_id = ?`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;