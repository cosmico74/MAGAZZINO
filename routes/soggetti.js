const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');
const bcrypt = require('bcrypt');

// ========== HELPER PER SINCRONIZZARE I REFERENTI ==========
async function syncSoggettiReferenti(connection, soggettoId, referenteStr) {
  await connection.query('DELETE FROM soggetti_referenti WHERE soggetto_id = ?', [soggettoId]);
  if (referenteStr && referenteStr.trim() !== '') {
    const referentiIds = referenteStr.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    for (const refId of referentiIds) {
      await connection.query(
        'INSERT INTO soggetti_referenti (soggetto_id, referente_id) VALUES (?, ?)',
        [soggettoId, refId]
      );
    }
  }
}

// ========== HELPER PER SINCRONIZZARE I MAGAZZINI ASSOCIATI ==========
async function syncSoggettiMagazzini(connection, soggettoId, magazziniIds) {
  await connection.query('DELETE FROM soggetti_magazzini WHERE soggetto_id = ?', [soggettoId]);
  if (magazziniIds && magazziniIds.length) {
    for (const magId of magazziniIds) {
      await connection.query(
        'INSERT INTO soggetti_magazzini (soggetto_id, magazzino_id) VALUES (?, ?)',
        [soggettoId, magId]
      );
    }
  }
}

// ========== GET soggetti per tipo (per dropdown) ==========
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

// ========== GET tutti i soggetti (con utente associato, referenti, magazzini) ==========
router.get('/', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT s.*, u.id AS utente_id, u.username AS utente_username, u.ruolo AS utente_ruolo
      FROM soggetti s
      LEFT JOIN utenti u ON u.riferimento_id = s.id
      ORDER BY s.tipo, s.nome, s.cognome
    `);
    
    const soggettiConReferenti = [];
    for (const row of rows) {
      const [refRows] = await db.query(
        'SELECT referente_id FROM soggetti_referenti WHERE soggetto_id = ?',
        [row.id]
      );
      const referentiIds = refRows.map(r => r.referente_id);
      const [magRows] = await db.query(
        'SELECT magazzino_id FROM soggetti_magazzini WHERE soggetto_id = ?',
        [row.id]
      );
      const magazziniIds = magRows.map(r => r.magazzino_id);
      
      const { utente_id, utente_username, utente_ruolo, ...soggetto } = row;
      if (utente_id) {
        soggetto.utenteAssociato = {
          id: utente_id,
          username: utente_username,
          ruolo: utente_ruolo
        };
      }
      soggetto.referenti = referentiIds;
      soggetto.magazziniAssociati = magazziniIds;
      soggettiConReferenti.push(soggetto);
    }
    res.json(soggettiConReferenti);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// ========== GET singolo soggetto (con utente associato, referenti, magazzini) ==========
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT s.*, u.id AS utente_id, u.username AS utente_username, u.ruolo AS utente_ruolo
      FROM soggetti s
      LEFT JOIN utenti u ON u.riferimento_id = s.id
      WHERE s.id = ?
    `, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Soggetto non trovato' });
    const row = rows[0];
    
    const [refRows] = await db.query(
      'SELECT referente_id FROM soggetti_referenti WHERE soggetto_id = ?',
      [req.params.id]
    );
    const referentiIds = refRows.map(r => r.referente_id);
    
    const [magRows] = await db.query(
      'SELECT magazzino_id FROM soggetti_magazzini WHERE soggetto_id = ?',
      [req.params.id]
    );
    const magazziniIds = magRows.map(r => r.magazzino_id);
    
    const { utente_id, utente_username, utente_ruolo, ...soggetto } = row;
    if (utente_id) {
      soggetto.utenteAssociato = { id: utente_id, username: utente_username, ruolo: utente_ruolo };
    }
    soggetto.referenti = referentiIds;
    soggetto.magazziniAssociati = magazziniIds;
    res.json(soggetto);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// ========== POST crea nuovo soggetto ==========
router.post('/', verifyToken, async (req, res) => {
  const { 
    tipo, nome, cognome, email, telefono, indirizzo, citta, cap, regione,
    referente, note, attivo, livello, utenteAssociato, nuovaPassword,
    magazziniAssociati 
  } = req.body;
  
  if (!tipo || !nome) {
    return res.status(400).json({ error: 'Tipo e nome sono obbligatori' });
  }
  
  const connection = await db.getConnection();
  await connection.beginTransaction();
  try {
    // Gestione referente: se arriva come array o stringa
    let referenteStr = null;
    if (referente) {
      if (Array.isArray(referente)) {
        referenteStr = referente.join(',');
      } else if (typeof referente === 'string') {
        referenteStr = referente;
      }
    }
    
    const [result] = await connection.query(
      `INSERT INTO soggetti (tipo, nome, cognome, email, telefono, indirizzo, citta, cap, regione, referente, note, attivo, livello)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tipo, nome, cognome || null, email || null, telefono || null, indirizzo || null, citta || null, cap || null, regione || null, referenteStr, note || null, attivo !== undefined ? attivo : 1, livello || null]
    );
    const soggettoId = result.insertId;

    // Sincronizza referenti (tabella soggetti_referenti)
    await syncSoggettiReferenti(connection, soggettoId, referenteStr);
    
    // Sincronizza magazzini associati
    await syncSoggettiMagazzini(connection, soggettoId, magazziniAssociati || []);
    
    let utenteCreato = null;
    
    // Gestione utente associato
    if (utenteAssociato) {
      const [userExists] = await connection.query(
        'SELECT id FROM utenti WHERE id = ? AND (riferimento_id IS NULL OR riferimento_id = ?)',
        [utenteAssociato, soggettoId]
      );
      if (userExists.length === 0) {
        throw new Error('Utente selezionato non valido o già associato a un altro soggetto');
      }
      await connection.query('UPDATE utenti SET riferimento_id = ? WHERE id = ?', [soggettoId, utenteAssociato]);
    } else if (tipo === 'PROMOTER') {
      // Crea nuovo utente per il promoter
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

// ========== PUT aggiorna soggetto ==========
router.put('/:id', verifyToken, async (req, res) => {
  const { 
    tipo, nome, cognome, email, telefono, indirizzo, citta, cap, regione,
    referente, note, attivo, livello, utenteAssociato,
    magazziniAssociati 
  } = req.body;
  
  const connection = await db.getConnection();
  await connection.beginTransaction();
  try {
    let referenteStr = null;
    if (referente) {
      if (Array.isArray(referente)) {
        referenteStr = referente.join(',');
      } else if (typeof referente === 'string') {
        referenteStr = referente;
      }
    }
    
    await connection.query(
      `UPDATE soggetti SET
        tipo = ?, nome = ?, cognome = ?, email = ?, telefono = ?, indirizzo = ?, citta = ?, cap = ?, regione = ?,
        referente = ?, note = ?, attivo = ?, livello = ?
       WHERE id = ?`,
      [tipo, nome, cognome || null, email || null, telefono || null, indirizzo || null, citta || null, cap || null, regione || null,
       referenteStr, note || null, attivo, livello || null, req.params.id]
    );
    
    // Sincronizza referenti
    await syncSoggettiReferenti(connection, req.params.id, referenteStr);
    
    // Sincronizza magazzini associati
    await syncSoggettiMagazzini(connection, req.params.id, magazziniAssociati || []);
    
    // Gestione utente associato
    if (utenteAssociato) {
      // Rimuovi eventuale associazione precedente
      await connection.query('UPDATE utenti SET riferimento_id = NULL WHERE riferimento_id = ?', [req.params.id]);
      const [userExists] = await connection.query(
        'SELECT id FROM utenti WHERE id = ? AND (riferimento_id IS NULL OR riferimento_id = ?)',
        [utenteAssociato, req.params.id]
      );
      if (userExists.length === 0) {
        throw new Error('Utente selezionato non valido o già associato a un altro soggetto');
      }
      await connection.query('UPDATE utenti SET riferimento_id = ? WHERE id = ?', [req.params.id, utenteAssociato]);
    } else {
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

// ========== DELETE soggetto ==========
router.delete('/:id', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  await connection.beginTransaction();
  try {
    // Dissocia eventuale utente
    await connection.query('UPDATE utenti SET riferimento_id = NULL WHERE riferimento_id = ?', [req.params.id]);
    // Elimina referenti (sia come soggetto che come referente)
    await connection.query('DELETE FROM soggetti_referenti WHERE soggetto_id = ? OR referente_id = ?', [req.params.id, req.params.id]);
    // Elimina associazioni magazzini
    await connection.query('DELETE FROM soggetti_magazzini WHERE soggetto_id = ?', [req.params.id]);
    // Elimina il soggetto
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