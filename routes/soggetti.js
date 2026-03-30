const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');
const bcrypt = require('bcrypt');

// GET soggetti per tipo
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

// GET tutti i soggetti
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
    // Aggiungi anche l'utente associato se presente
    const [user] = await db.query('SELECT id, username, ruolo FROM utenti WHERE riferimento_id = ?', [req.params.id]);
    const soggetto = rows[0];
    if (user.length) {
      soggetto.utenteAssociato = user[0].id;
      soggetto.utenteUsername = user[0].username;
      soggetto.utenteRuolo = user[0].ruolo;
    } else {
      soggetto.utenteAssociato = null;
    }
    res.json(soggetto);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// POST crea nuovo soggetto (con gestione utente associato)
router.post('/', verifyToken, async (req, res) => {
  const { tipo, nome, cognome, email, telefono, indirizzo, citta, cap, regione, referente, note, attivo, livello, utenteAssociato, nuovaPassword } = req.body;
  if (!tipo || !nome) {
    return res.status(400).json({ error: 'Tipo e nome sono obbligatori' });
  }
  const connection = await db.getConnection();
  await connection.beginTransaction();
  try {
    // 1. Inserisci soggetto
    const [result] = await connection.query(
      `INSERT INTO soggetti (tipo, nome, cognome, email, telefono, indirizzo, citta, cap, regione, referente, note, attivo, livello)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tipo, nome, cognome || null, email || null, telefono || null, indirizzo || null, citta || null, cap || null, regione || null, referente || null, note || null, attivo !== undefined ? attivo : 1, livello || null]
    );
    const soggettoId = result.insertId;

    let utenteCreato = null;

    // 2. Gestione utente associato
    if (utenteAssociato) {
      // Associa un utente esistente
      const [userExists] = await connection.query('SELECT id FROM utenti WHERE id = ? AND riferimento_id IS NULL', [utenteAssociato]);
      if (userExists.length === 0) {
        throw new Error('Utente selezionato non valido o già associato a un altro soggetto');
      }
      await connection.query('UPDATE utenti SET riferimento_id = ? WHERE id = ?', [soggettoId, utenteAssociato]);
    } else if (tipo === 'PROMOTER') {
      // Crea un nuovo utente per promoter
      const username = email ? email.split('@')[0] : (nome + (cognome ? cognome : '')).toLowerCase().replace(/\s/g, '');
      const password = nuovaPassword && nuovaPassword.trim() ? nuovaPassword.trim() : Math.random().toString(36).slice(-8);
      const hashedPassword = await bcrypt.hash(password, 10);
      const nomeVisualizzato = `${nome} ${cognome || ''}`.trim();
      const [userResult] = await connection.query(
        `INSERT INTO utenti (username, password_hash, ruolo, riferimento_id, nome_visualizzato, email)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [username, hashedPassword, 'promoter', soggettoId, nomeVisualizzato, email || null]
      );
      utenteCreato = { username, password, id: userResult.insertId };
    }

    await connection.commit();
    res.json({ success: true, id: soggettoId, utenteCreato });
  } catch (err) {
    await connection.rollback();
    console.error('Errore POST /soggetti:', err);
    res.status(500).json({ error: err.message || 'Errore database' });
  } finally {
    connection.release();
  }
});

// PUT aggiorna soggetto (gestisce anche associazione utente)
router.put('/:id', verifyToken, async (req, res) => {
  const { tipo, nome, cognome, email, telefono, indirizzo, citta, cap, regione, referente, note, attivo, livello, utenteAssociato } = req.body;
  const connection = await db.getConnection();
  await connection.beginTransaction();
  try {
    // 1. Aggiorna soggetto
    await connection.query(
      `UPDATE soggetti SET
        tipo = ?, nome = ?, cognome = ?, email = ?, telefono = ?, indirizzo = ?, citta = ?, cap = ?, regione = ?, referente = ?, note = ?, attivo = ?, livello = ?
       WHERE id = ?`,
      [tipo, nome, cognome || null, email || null, telefono || null, indirizzo || null, citta || null, cap || null, regione || null, referente || null, note || null, attivo, livello || null, req.params.id]
    );

    // 2. Gestisci l'associazione utente
    if (utenteAssociato) {
      // Rimuovi eventuale utente attualmente associato a questo soggetto
      await connection.query('UPDATE utenti SET riferimento_id = NULL WHERE riferimento_id = ?', [req.params.id]);
      // Associa il nuovo utente (controlla che non sia già associato ad altri)
      const [userExists] = await connection.query('SELECT id FROM utenti WHERE id = ? AND (riferimento_id IS NULL OR riferimento_id = ?)', [utenteAssociato, req.params.id]);
      if (userExists.length === 0) {
        throw new Error('Utente selezionato non valido o già associato a un altro soggetto');
      }
      await connection.query('UPDATE utenti SET riferimento_id = ? WHERE id = ?', [req.params.id, utenteAssociato]);
    } else {
      // Se utenteAssociato è vuoto, rimuovi l'associazione
      await connection.query('UPDATE utenti SET riferimento_id = NULL WHERE riferimento_id = ?', [req.params.id]);
    }

    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    console.error('Errore PUT /soggetti:', err);
    res.status(500).json({ error: err.message || 'Errore database' });
  } finally {
    connection.release();
  }
});

// DELETE soggetto
router.delete('/:id', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  await connection.beginTransaction();
  try {
    // Rimuovi l'associazione utente prima di cancellare il soggetto
    await connection.query('UPDATE utenti SET riferimento_id = NULL WHERE riferimento_id = ?', [req.params.id]);
    const [result] = await connection.query('DELETE FROM soggetti WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) throw new Error('Soggetto non trovato');
    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

module.exports = router;