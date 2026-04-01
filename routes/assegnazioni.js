const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');

const router = express.Router();

// ========== HELPER: OTTIENI OGGETTI IN CARICO PER UN SOGGETTO ==========
async function getOggettiInCarico(destinazioneTipo, destinazioneId, magazzinoFiltro = null) {
  let query = `
    SELECT 
      cs.destinazione_tipo,
      cs.destinazione_id,
      cs.tipo_oggetto,
      cs.oggetto_id,
      cs.quantita,
      CASE 
        WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.descrizione_completa
        WHEN cs.tipo_oggetto = 'KIT' THEN k.descrizione
      END AS descrizione,
      CASE 
        WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.codice
        WHEN cs.tipo_oggetto = 'KIT' THEN k.codice_kit
      END AS codice,
      CASE 
        WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.lunghezza
        WHEN cs.tipo_oggetto = 'KIT' THEN sci.lunghezza
      END AS LUNGHEZZA,
      CASE 
        WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.durezza
        WHEN cs.tipo_oggetto = 'KIT' THEN sci.durezza
      END AS DUREZZA,
      CASE 
        WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.sigla
        WHEN cs.tipo_oggetto = 'KIT' THEN k.sigla
      END AS SIGLA,
      CASE 
        WHEN cs.tipo_oggetto = 'ARTICOLO' THEN NULL
        WHEN cs.tipo_oggetto = 'KIT' THEN sci.sigla
      END AS SCI_SIGLA,
      CASE 
        WHEN cs.tipo_oggetto = 'ARTICOLO' THEN NULL
        WHEN cs.tipo_oggetto = 'KIT' THEN sci.descrizione
      END AS SCI_DESCRIZIONE,
      CASE 
        WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.magazzino
        WHEN cs.tipo_oggetto = 'KIT' THEN k.magazzino
      END AS MAGAZZINO,
      a.settore AS SETTORE,
      a.marca AS MARCA,
      a.codice_modello AS CODICE_MODELLO,
      a.categoria AS CATEGORIA
    FROM carico_sintesi cs
    LEFT JOIN articoli a ON cs.tipo_oggetto = 'ARTICOLO' AND cs.oggetto_id = a.articolo_id
    LEFT JOIN kit k ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id
    LEFT JOIN articoli sci ON k.id_sci = sci.articolo_id
    WHERE cs.destinazione_tipo = ? AND cs.destinazione_id = ?
  `;
  const params = [destinazioneTipo, destinazioneId];
  if (magazzinoFiltro) {
    query += ' AND (a.magazzino = ? OR k.magazzino = ?)';
    params.push(magazzinoFiltro, magazzinoFiltro);
  }
  const [rows] = await pool.query(query, params);
  return rows.map(row => ({
    tipo: row.tipo_oggetto,
    ID: row.oggetto_id,
    descrizione: row.descrizione || '',
    codice: row.codice || '',
    quantita: row.quantita,
    LUNGHEZZA: row.LUNGHEZZA || '',
    DUREZZA: row.DUREZZA || '',
    SIGLA: row.SIGLA || '',
    SCI_SIGLA: row.SCI_SIGLA || '',
    SCI_DESCRIZIONE: row.SCI_DESCRIZIONE || '',
    SCI_LUNGHEZZA: row.LUNGHEZZA || '',
    SCI_DUREZZA: row.DUREZZA || '',
    MAGAZZINO: row.MAGAZZINO,
    SETTORE: row.SETTORE,
    MARCA: row.MARCA,
    CODICE_MODELLO: row.CODICE_MODELLO,
    CATEGORIA: row.CATEGORIA,
    destinazioneTipo: row.destinazione_tipo,
    destinazioneId: row.destinazione_id
  }));
}

// ========== HELPER: RICORSIVO PER OTTENERE TUTTI I SOGGETTI REFERENZIATI ==========
async function getSoggettiReferenziati(soggettoId) {
  // CORREZIONE: usa soggetto_id (singolare) invece di soggetti_id
  const [diretti] = await pool.query(
    'SELECT soggetto_id FROM soggetti_referenti WHERE referente_id = ?',
    [soggettoId]
  );
  let result = diretti.map(r => r.soggetto_id);
  for (const id of result) {
    const sub = await getSoggettiReferenziati(id);
    result = result.concat(sub);
  }
  return result;
}

// ========== HELPER: OTTIENI OGGETTI IN CARICO PER UN SOGGETTO + REFERENTI ==========
async function getOggettiPerSoggettoConReferenti(tipo, id, magazzinoFiltro = null) {
  let oggetti = await getOggettiInCarico(tipo, id, magazzinoFiltro);
  oggetti = oggetti.map(o => ({ ...o, destinazioneTipo: tipo, destinazioneId: id, tipoAssegnazione: 'diretta' }));

  const referentiIds = await getSoggettiReferenziati(id);
  for (const refId of referentiIds) {
    const [sog] = await pool.query('SELECT tipo FROM soggetti WHERE id = ?', [refId]);
    if (sog.length === 0) continue;
    const tipoRef = sog[0].tipo;
    const oggettiRef = await getOggettiInCarico(tipoRef, refId, magazzinoFiltro);
    oggetti.push(...oggettiRef.map(o => ({
      ...o,
      destinazioneTipo: tipoRef,
      destinazioneId: refId,
      tipoAssegnazione: 'referente'
    })));
  }

  const [soggetti] = await pool.query('SELECT id, tipo, nome, cognome FROM soggetti');
  const sogMap = new Map();
  soggetti.forEach(s => sogMap.set(`${s.tipo}|${s.id}`, s));
  oggetti = oggetti.map(o => {
    const sog = sogMap.get(`${o.destinazioneTipo}|${o.destinazioneId}`);
    let destinatarioNome = '';
    if (sog) {
      if (o.destinazioneTipo === 'PROMOTER') destinatarioNome = (sog.nome + ' ' + sog.cognome).trim();
      else destinatarioNome = sog.nome || '';
    }
    return { ...o, destinatarioNome };
  });
  return oggetti;
}

// ========== HELPER: AGGIORNA SINTESI CARICO ==========
async function aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, variazione) {
  const query = `
    INSERT INTO carico_sintesi (destinazione_tipo, destinazione_id, tipo_oggetto, oggetto_id, quantita)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE quantita = quantita + VALUES(quantita)
  `;
  await connection.query(query, [destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, variazione]);
  const [check] = await connection.query(
    'SELECT quantita FROM carico_sintesi WHERE destinazione_tipo = ? AND destinazione_id = ? AND tipo_oggetto = ? AND oggetto_id = ?',
    [destinazioneTipo, destinazioneId, tipoOggetto, oggettoId]
  );
  if (check.length && check[0].quantita === 0) {
    await connection.query(
      'DELETE FROM carico_sintesi WHERE destinazione_tipo = ? AND destinazione_id = ? AND tipo_oggetto = ? AND oggetto_id = ?',
      [destinazioneTipo, destinazioneId, tipoOggetto, oggettoId]
    );
  }
}

// ========== OPERAZIONI TRANSIZIONALI (esportate) ==========
async function registraUscitaTransazionale(connection, params) {
  const { magazzinoId, tipoOggetto, oggettoId, quantita, destinazioneTipo, destinazioneId, note, operatore, userId } = params;
  if (tipoOggetto === 'ARTICOLO') {
    const [art] = await connection.query('SELECT (quantita_totale - quantita_in_kit) AS giacenza_reale FROM articoli WHERE articolo_id = ? FOR UPDATE', [oggettoId]);
    if (!art.length || art[0].giacenza_reale < quantita) throw new Error('Giacenza articolo insufficiente');
    await connection.query('UPDATE articoli SET quantita_totale = quantita_totale - ?, data_modifica = NOW() WHERE articolo_id = ?', [quantita, oggettoId]);
  } else {
    const [kit] = await connection.query('SELECT quantita FROM kit WHERE id = ? FOR UPDATE', [oggettoId]);
    if (!kit.length || kit[0].quantita < quantita) throw new Error('Quantità kit insufficiente');
    await connection.query('UPDATE kit SET quantita = quantita - ?, data_modifica = NOW() WHERE id = ?', [quantita, oggettoId]);
  }
  await connection.query(
    `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente)
     VALUES (NOW(), 'USCITA', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
    [`MAGAZZINO-${magazzinoId}`, `${destinazioneTipo}-${destinazioneId}`, oggettoId, tipoOggetto, quantita, operatore, note, userId]
  );
  await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, +quantita);
}

async function registraRientroTransazionale(connection, params) {
  const { daTipo, daId, magazzinoId, tipoOggetto, oggettoId, quantita, note, operatore, userId } = params;
  if (tipoOggetto === 'ARTICOLO') {
    await connection.query('UPDATE articoli SET quantita_totale = quantita_totale + ?, data_modifica = NOW() WHERE articolo_id = ?', [quantita, oggettoId]);
  } else {
    await connection.query('UPDATE kit SET quantita = quantita + ?, data_modifica = NOW() WHERE id = ?', [quantita, oggettoId]);
  }
  await connection.query(
    `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente)
     VALUES (NOW(), 'RIENTRO', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
    [`${daTipo}-${daId}`, `MAGAZZINO-${magazzinoId}`, oggettoId, tipoOggetto, quantita, operatore, note, userId]
  );
  await aggiornaSintesiCarico(connection, daTipo, daId, tipoOggetto, oggettoId, -quantita);
}

// ========== ROTTA PRINCIPALE: OTTIENI OGGETTI ==========
router.post('/oggetti', verifyToken, async (req, res) => {
  try {
    const { magazzino, targetTipo, targetId, includeReferenced } = req.body;
    const userId = req.userId;

    const [userRows] = await pool.query('SELECT ruolo FROM utenti WHERE id = ?', [userId]);
    if (userRows.length === 0) return res.status(404).json({ success: false, message: 'Utente non trovato' });
    const ruolo = userRows[0].ruolo;

    // ADMIN
    if (ruolo === 'admin') {
      if (targetTipo && targetId) {
        let oggetti;
        if (includeReferenced) {
          oggetti = await getOggettiPerSoggettoConReferenti(targetTipo, targetId, magazzino);
        } else {
          oggetti = await getOggettiInCarico(targetTipo, targetId, magazzino);
          const [sog] = await pool.query('SELECT * FROM soggetti WHERE id = ?', [targetId]);
          let destinatarioNome = '';
          if (sog.length) {
            if (targetTipo === 'PROMOTER') destinatarioNome = (sog[0].nome + ' ' + sog[0].cognome).trim();
            else destinatarioNome = sog[0].nome || '';
          }
          oggetti = oggetti.map(o => ({ ...o, destinazioneTipo: targetTipo, destinazioneId: targetId, destinatarioNome, tipoAssegnazione: 'me' }));
        }
        return res.json({ success: true, oggetti });
      } else {
        // Restituisce tutte le assegnazioni
        let query = `
          SELECT cs.*,
            CASE 
              WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.descrizione_completa
              ELSE k.descrizione
            END AS descrizione,
            CASE 
              WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.codice
              ELSE k.codice_kit
            END AS codice,
            CASE 
              WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.lunghezza
              ELSE sci.lunghezza
            END AS LUNGHEZZA,
            CASE 
              WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.durezza
              ELSE sci.durezza
            END AS DUREZZA,
            CASE 
              WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.sigla
              ELSE k.sigla
            END AS SIGLA,
            CASE 
              WHEN cs.tipo_oggetto = 'ARTICOLO' THEN NULL
              ELSE sci.sigla
            END AS SCI_SIGLA,
            CASE 
              WHEN cs.tipo_oggetto = 'ARTICOLO' THEN NULL
              ELSE sci.descrizione
            END AS SCI_DESCRIZIONE,
            CASE 
              WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.magazzino
              ELSE k.magazzino
            END AS MAGAZZINO,
            a.settore AS SETTORE,
            a.marca AS MARCA,
            a.codice_modello AS CODICE_MODELLO
          FROM carico_sintesi cs
          LEFT JOIN articoli a ON cs.tipo_oggetto = 'ARTICOLO' AND cs.oggetto_id = a.articolo_id
          LEFT JOIN kit k ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id
          LEFT JOIN articoli sci ON k.id_sci = sci.articolo_id
          WHERE cs.quantita > 0
        `;
        const params = [];
        if (magazzino) {
          query += ' AND (a.magazzino = ? OR k.magazzino = ?)';
          params.push(magazzino, magazzino);
        }
        const [all] = await pool.query(query, params);
        const [soggetti] = await pool.query('SELECT * FROM soggetti');
        const sogMap = new Map();
        soggetti.forEach(s => sogMap.set(`${s.tipo}|${s.id}`, s));
        const tutte = all.map(row => {
          const sog = sogMap.get(`${row.destinazione_tipo}|${row.destinazione_id}`);
          let destinatarioNome = '';
          if (sog) {
            if (row.destinazione_tipo === 'PROMOTER') destinatarioNome = (sog.nome + ' ' + sog.cognome).trim();
            else destinatarioNome = sog.nome || '';
          }
          return {
            tipo: row.tipo_oggetto,
            ID: row.oggetto_id,
            descrizione: row.descrizione || '',
            codice: row.codice || '',
            quantita: row.quantita,
            LUNGHEZZA: row.LUNGHEZZA || '',
            DUREZZA: row.DUREZZA || '',
            SIGLA: row.SIGLA || '',
            SCI_SIGLA: row.SCI_SIGLA || '',
            SCI_DESCRIZIONE: row.SCI_DESCRIZIONE || '',
            SCI_LUNGHEZZA: row.LUNGHEZZA || '',
            SCI_DUREZZA: row.DUREZZA || '',
            MAGAZZINO: row.MAGAZZINO,
            SETTORE: row.SETTORE,
            MARCA: row.MARCA,
            CODICE_MODELLO: row.CODICE_MODELLO,
            destinazioneTipo: row.destinazione_tipo,
            destinazioneId: row.destinazione_id,
            destinatarioNome
          };
        });
        return res.json({ success: true, oggetti: tutte });
      }
    }

    // Non admin
    const [user] = await pool.query('SELECT ruolo, riferimento_id FROM utenti WHERE id = ?', [userId]);
    if (user.length === 0) throw new Error('Utente senza riferimento');
    const riferimentoId = user[0].riferimento_id;
    const ruoloUtente = user[0].ruolo.toUpperCase();

    let oggetti = await getOggettiInCarico(ruoloUtente, riferimentoId, magazzino);
    oggetti = oggetti.map(o => ({ ...o, destinazioneTipo: ruoloUtente, destinazioneId: riferimentoId, tipoAssegnazione: 'me' }));

    // Referenti
    const referentiIds = await getSoggettiReferenziati(riferimentoId);
    for (const refId of referentiIds) {
      const [sog] = await pool.query('SELECT tipo FROM soggetti WHERE id = ?', [refId]);
      if (sog.length === 0) continue;
      const tipoRef = sog[0].tipo;
      const oggettiRef = await getOggettiInCarico(tipoRef, refId, magazzino);
      oggetti.push(...oggettiRef.map(o => ({
        ...o,
        destinazioneTipo: tipoRef,
        destinazioneId: refId,
        tipoAssegnazione: 'referente'
      })));
    }

    // Aggiungi nomi
    const [soggetti] = await pool.query('SELECT id, tipo, nome, cognome FROM soggetti');
    const sogMap = new Map();
    soggetti.forEach(s => sogMap.set(`${s.tipo}|${s.id}`, s));
    oggetti = oggetti.map(o => {
      const sog = sogMap.get(`${o.destinazioneTipo}|${o.destinazioneId}`);
      let destinatarioNome = '';
      if (sog) {
        if (o.destinazioneTipo === 'PROMOTER') destinatarioNome = (sog.nome + ' ' + sog.cognome).trim();
        else destinatarioNome = sog.nome || '';
      }
      return { ...o, destinatarioNome };
    });

    res.json({ success: true, oggetti });
  } catch (error) {
    console.error('Errore in /oggetti:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== USCITE MULTIPLE ==========
router.post('/uscita/batch', verifyToken, async (req, res) => {
  const { magazzinoId, destinazioneTipo, destinazioneId, note, oggetti } = req.body;
  if (!destinazioneTipo || !destinazioneId || !oggetti || !oggetti.length) {
    return res.status(400).json({ success: false, message: 'Parametri mancanti' });
  }
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const [user] = await connection.query('SELECT * FROM utenti WHERE id = ?', [req.userId]);
    const operatore = user[0].username;
    for (const item of oggetti) {
      if (!magazzinoId) throw new Error('Magazzino di partenza richiesto per le uscite dirette dal magazzino');
      await registraUscitaTransazionale(connection, {
        magazzinoId,
        tipoOggetto: item.tipoOggetto,
        oggettoId: item.oggettoId,
        quantita: item.quantita,
        destinazioneTipo,
        destinazioneId,
        note,
        operatore,
        userId: req.userId
      });
    }
    await connection.commit();
    res.json({ success: true, message: `Assegnati ${oggetti.length} oggetti` });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

// ========== RIENTRI MULTIPLI ==========
router.post('/rientro/batch', verifyToken, async (req, res) => {
  const { magazzinoId, note, oggetti } = req.body;
  if (!magazzinoId || !oggetti || !oggetti.length) {
    return res.status(400).json({ success: false, message: 'Parametri mancanti' });
  }
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const [user] = await connection.query('SELECT * FROM utenti WHERE id = ?', [req.userId]);
    const operatore = user[0].username;
    for (const item of oggetti) {
      let daTipo = item.daTipo;
      let daId = item.daId;
      if (!daTipo || !daId) {
        const [u] = await connection.query('SELECT ruolo, riferimento_id FROM utenti WHERE id = ?', [req.userId]);
        daTipo = u[0].ruolo.toUpperCase();
        daId = u[0].riferimento_id;
      }
      await registraRientroTransazionale(connection, {
        daTipo,
        daId,
        magazzinoId,
        tipoOggetto: item.tipoOggetto,
        oggettoId: item.oggettoId,
        quantita: item.quantita,
        note,
        operatore,
        userId: req.userId
      });
    }
    await connection.commit();
    res.json({ success: true, message: `Rientrati ${oggetti.length} oggetti` });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

// ========== TRASFERIMENTO DIRETTO TRA SOGGETTI ==========
router.post('/trasferimento', verifyToken, async (req, res) => {
  const { daTipo, daId, aTipo, aId, magazzinoId, oggetti, note } = req.body;
  if (!daTipo || !daId || !aTipo || !aId || !oggetti || !oggetti.length) {
    return res.status(400).json({ success: false, message: 'Parametri mancanti' });
  }

  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const [user] = await connection.query('SELECT * FROM utenti WHERE id = ?', [req.userId]);
    const operatore = user[0].username;

    for (const item of oggetti) {
      // 1. Rientro dal soggetto di partenza al magazzino
      await registraRientroTransazionale(connection, {
        daTipo,
        daId,
        magazzinoId,
        tipoOggetto: item.tipoOggetto,
        oggettoId: item.oggettoId,
        quantita: item.quantita,
        note: note || `Trasferimento a ${aTipo} ${aId}`,
        operatore,
        userId: req.userId
      });

      // 2. Uscita dal magazzino al soggetto di destinazione
      await registraUscitaTransazionale(connection, {
        magazzinoId,
        tipoOggetto: item.tipoOggetto,
        oggettoId: item.oggettoId,
        quantita: item.quantita,
        destinazioneTipo: aTipo,
        destinazioneId: aId,
        note: note || `Trasferimento da ${daTipo} ${daId}`,
        operatore,
        userId: req.userId
      });
    }

    await connection.commit();
    res.json({ success: true, message: `Trasferiti ${oggetti.length} oggetti` });
  } catch (error) {
    await connection.rollback();
    console.error('Errore in /trasferimento:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

module.exports = router;
module.exports.registraUscitaTransazionale = registraUscitaTransazionale;
module.exports.registraRientroTransazionale = registraRientroTransazionale;