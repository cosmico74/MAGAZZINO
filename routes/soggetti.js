const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');

// GET soggetti per tipo (usa la tabella unificata soggetti)
router.get('/tipo/:tipo', verifyToken, async (req, res) => {
  const { tipo } = req.params;
  const validi = ['PROMOTER', 'NEGOZIO', 'CLIENTE', 'AGENTE'];
  if (!validi.includes(tipo)) {
    return res.status(400).json({ error: 'Tipo non valido' });
  }
  try {
    const [rows] = await db.query(
      'SELECT id, tipo, nome, cognome, email, telefono FROM soggetti WHERE tipo = ? ORDER BY nome, cognome',
      [tipo]
    );
    res.json(rows);
  } catch (err) {
    console.error('Errore in /soggetti/tipo:', err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// GET tutti i soggetti (opzionale, per eventuali estensioni)
router.get('/', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM soggetti ORDER BY tipo, nome, cognome');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// GET singolo soggetto
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM soggetti WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Soggetto non trovato' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// POST crea nuovo soggetto
router.post('/', verifyToken, async (req, res) => {
  const { tipo, nome, cognome, email, telefono, indirizzo, citta, cap, regione, referente, note, attivo } = req.body;
  if (!tipo || !nome) {
    return res.status(400).json({ error: 'Tipo e nome sono obbligatori' });
  }
  try {
    const [result] = await db.query(
      `INSERT INTO soggetti (tipo, nome, cognome, email, telefono, indirizzo, citta, cap, regione, referente, note, attivo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tipo, nome, cognome || null, email || null, telefono || null, indirizzo || null, citta || null, cap || null, regione || null, referente || null, note || null, attivo !== undefined ? attivo : 1]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// PUT aggiorna soggetto
router.put('/:id', verifyToken, async (req, res) => {
  const { tipo, nome, cognome, email, telefono, indirizzo, citta, cap, regione, referente, note, attivo } = req.body;
  try {
    const [result] = await db.query(
      `UPDATE soggetti SET
        tipo = ?, nome = ?, cognome = ?, email = ?, telefono = ?, indirizzo = ?, citta = ?, cap = ?, regione = ?, referente = ?, note = ?, attivo = ?
       WHERE id = ?`,
      [tipo, nome, cognome || null, email || null, telefono || null, indirizzo || null, citta || null, cap || null, regione || null, referente || null, note || null, attivo, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Soggetto non trovato' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// DELETE soggetto
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const [result] = await db.query('DELETE FROM soggetti WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Soggetto non trovato' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

module.exports = router;