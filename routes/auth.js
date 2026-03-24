const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username e password obbligatori' });
  }
  try {
    const [rows] = await pool.query(
      'SELECT id, username, password_hash, salt, ruolo, riferimento_id, nome_visualizzato, email FROM utenti WHERE username = ?',
      [username]
    );
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Utente non trovato' });
    }
    const user = rows[0];
    const valid = await bcrypt.compare(password + user.salt, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Password errata' });
    }
    const token = jwt.sign(
      { userId: user.id, role: user.ruolo },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        ruolo: user.ruolo,
        riferimentoId: user.riferimento_id,
        nome: user.nome_visualizzato,
        email: user.email
      },
      token
    });
  } catch (error) {
    console.error('Errore in /login:', error);
    res.status(500).json({ success: false, message: 'Errore interno del server' });
  }
});

router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Auth route funziona' });
});

module.exports = router;