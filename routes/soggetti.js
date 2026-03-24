const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');

const router = express.Router();

router.get('/', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM soggetti');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/tipo/:tipo', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM soggetti WHERE tipo = ?', [req.params.tipo]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;