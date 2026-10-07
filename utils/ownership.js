const db = require('../db');

// Returns the course if the logged-in teacher owns it (admins may access any course).
async function ownedCourse(user, courseId) {
  const [rows] = await db.query('SELECT * FROM courses WHERE course_id = ?', [courseId]);
  const course = rows[0];
  if (!course) return null;
  if (user.role !== 'admin' && course.teacher_id !== user.user_id) return null;
  return course;
}

async function ownedSession(user, sessionId) {
  const [rows] = await db.query(
    `SELECT s.*, c.teacher_id, c.course_name, c.course_code
     FROM sessions s JOIN courses c ON c.course_id = s.course_id
     WHERE s.session_id = ?`,
    [sessionId]
  );
  const session = rows[0];
  if (!session) return null;
  if (user.role !== 'admin' && session.teacher_id !== user.user_id) return null;
  return session;
}

module.exports = { ownedCourse, ownedSession };
