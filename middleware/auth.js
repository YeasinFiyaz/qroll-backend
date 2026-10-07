const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Please log in first' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Your session has expired, please log in again' });
  }
}

// Teachers and admins share the teaching features.
function teacherOnly(req, res, next) {
  if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only teachers can do this' });
  }
  next();
}

function studentOnly(req, res, next) {
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Only students can do this' });
  }
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access only' });
  }
  next();
}

module.exports = authMiddleware;
module.exports.teacherOnly = teacherOnly;
module.exports.adminOnly = adminOnly;
module.exports.studentOnly = studentOnly;
