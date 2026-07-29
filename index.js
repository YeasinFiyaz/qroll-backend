const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const authRoutes    = require('./routes/auth');
const sessionRoutes = require('./routes/sessions');
const attendRoutes  = require('./routes/attend');
const reportRoutes  = require('./routes/reports');
const courseRoutes  = require('./routes/courses');

app.use('/api/v1/auth',     authRoutes);
app.use('/api/v1/sessions', sessionRoutes);
app.use('/api/v1/attend',   attendRoutes);
app.use('/api/v1/reports',  reportRoutes);
app.use('/api/v1/courses',  courseRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'QRoll API is running!' });
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});