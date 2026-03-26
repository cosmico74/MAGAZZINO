const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');
const bcrypt = require('bcrypt');

const router = express.Router();

async function isAdmin(userId) {
  const [rows] = await pool.query('SELECT ruolo FROM utenti WHERE id = ?', [userId]);
  return rows.length && rows[0].ruolo === 'admin';
}

// GET /api/utenti
router.get('/', verifyToken, async (req, res) => {
  try {
    if (!(await isAdmin(req.userId))) {
      return res.status(403).json({ success: false, message: 'Accesso negato' });
    }
    const [rows] = await pool.query('SELECT id, username, ruolo, riferimento_id, nome_visualizzato, email FROM utenti');
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/utenti
router.post('/', verifyToken, async (req, res) => {
  try {
    if (!(await isAdmin(req.userId))) {
      return res.status(403).json({ success: false, message: 'Accesso negato' });
    }
    const { username, password, ruolo, riferimentoId, nomeVisualizzato, email } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username e password obbligatori' });
    }
    const [existing] = await pool.query('SELECT id FROM utenti WHERE username = ?', [username]);
    if (existing.length) {
      return res.status(400).json({ success: false, message: 'Username già esistente' });
    }
    const hashed = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      `INSERT INTO utenti (username, password_hash, ruolo, riferimento_id, nome_visualizzato, email)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [username, hashed, ruolo, riferimentoId || null, nomeVisualizzato || null, email || null]
    );
    res.json({ success: true, message: 'Utente creato', id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/utenti/:id
router.put('/:id', verifyToken, async (req, res) => {
  try {
    if (!(await isAdmin(req.userId))) {
      return res.status(403).json({ success: false, message: 'Accesso negato' });
    }
    const { id } = req.params;
    const { username, password, ruolo, riferimentoId, nomeVisualizzato, email } = req.body;
    if (!username) {
      return res.status(400).json({ success: false, message: 'Username obbligatorio' });
    }
    let updateFields = 'username = ?, ruolo = ?, riferimento_id = ?, nome_visualizzato = ?, email = ?';
    const values = [username, ruolo, riferimentoId || null, nomeVisualizzato || null, email || null];
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      updateFields += ', password_hash = ?';
      values.push(hashed);
    }
    values.push(id);
    await pool.query(`UPDATE utenti SET ${updateFields} WHERE id = ?`, values);
    res.json({ success: true, message: 'Utente aggiornato' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/utenti/:id
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    if (!(await isAdmin(req.userId))) {
      return res.status(403).json({ success: false, message: 'Accesso negato' });
    }
    const { id } = req.params;
    await pool.query('DELETE FROM utenti WHERE id = ?', [id]);
    res.json({ success: true, message: 'Utente eliminato' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;