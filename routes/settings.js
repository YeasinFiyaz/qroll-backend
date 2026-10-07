const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { adminOnly } = authMiddleware;
const { getFeatures, updateFeatures, FEATURE_LABELS } = require('../utils/settings');

// Public: the frontend reads the switches before login too (e.g. sign-up form).
router.get('/', async (req, res) => {
  res.json({ features: await getFeatures() });
});

router.get('/labels', authMiddleware, adminOnly, (req, res) => {
  res.json(FEATURE_LABELS);
});

router.put('/features', authMiddleware, adminOnly, async (req, res) => {
  const features = await updateFeatures(req.body?.features || req.body);
  res.json({ message: 'Settings saved', features });
});

module.exports = router;
