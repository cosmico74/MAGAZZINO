const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');

const router = express.Router();

// ========== HELPER: AGGIORNA SINTESI CARICO (con provenienza e data) ==========
async function aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId, variazione, provenienzaTipo = null, provenienzaId = null, dataAssegnazione = null) {
  const query = `
    INSERT INTO carico_sintesi (destinazione_tipo, destinazione_id, tipo_oggetto, oggetto_id, sigla_id, quantita, provenienza_tipo, provenienza_id, data_assegnazione)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE 
      quantita = quantita + VALUES(quantita),
      provenienza_tipo = IF(VALUES(quantita) > 0, VALUES(provenienza_tipo), provenienza_tipo),
      provenienza_id = IF(VALUES(quantita) > 0, VALUES(provenienza_id), provenienza_id),
      data_assegnazione = IF(VALUES(quantita) > 0, VALUES(data_assegnazione), data_assegnazione)
  `;
  await connection.query(query, [destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId, variazione, provenienzaTipo, provenienzaId, dataAssegnazione || new Date()]);
  
  // Se la quantità diventa 0, elimina la riga
  const [check] = await connection.query(
    `SELECT quantita FROM carico_sintesi 
     WHERE destinazione_tipo = ? AND destinazione_id = ? AND tipo_oggetto = ? AND oggetto_id = ? 
     AND (sigla_id = ? OR (sigla_id IS NULL AND ? IS NULL))`,
    [destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId, siglaId]
  );
  if (check.length && check[0].quantita === 0) {
    await connection.query(
      `DELETE FROM carico_sintesi 
       WHERE destinazione_tipo = ? AND destinazione_id = ? AND tipo_oggetto = ? AND oggetto_id = ? 
       AND (sigla_id = ? OR (sigla_id IS NULL AND ? IS NULL))`,
      [destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId, siglaId]
    );
  }
}

// ========== OPERAZIONI TRANSIZIONALI ==========
async function registraUscitaTransazionale(connection, params) {
  const { magazzinoId, tipoOggetto, oggettoId, siglaId, quantita, destinazioneTipo, destinazioneId, note, operatore, userId } = params;
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
    `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente, sigla_id)
     VALUES (NOW(), 'USCITA', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?, ?)`,
    [`MAGAZZINO-${magazzinoId}`, `${destinazioneTipo}-${destinazioneId}`, oggettoId, tipoOggetto, quantita, operatore, note, userId, siglaId || null]
  );
  // Aggiorna carico_sintesi con provenienza = MAGAZZINO
  await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId, +quantita, 'MAGAZZINO', magazzinoId, new Date());
}

async function registraRientroTransazionale(connection, params) {
  const { daTipo, daId, magazzinoId, tipoOggetto, oggettoId, siglaId, quantita, note, operatore, userId } = params;
  if (tipoOggetto === 'ARTICOLO') {
    await connection.query('UPDATE articoli SET quantita_totale = quantita_totale + ?, data_modifica = NOW() WHERE articolo_id = ?', [quantita, oggettoId]);
  } else {
    await connection.query('UPDATE kit SET quantita = quantita + ?, data_modifica = NOW() WHERE id = ?', [quantita, oggettoId]);
  }
  await connection.query(
    `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente, sigla_id)
     VALUES (NOW(), 'RIENTRO', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?, ?)`,
    [`${daTipo}-${daId}`, `MAGAZZINO-${magazzinoId}`, oggettoId, tipoOggetto, quantita, operatore, note, userId, siglaId || null]
  );
  // Rientro: decrementa quantità dal soggetto mittente (non serve aggiornare provenienza)
  await aggiornaSintesiCarico(connection, daTipo, daId, tipoOggetto, oggettoId, siglaId, -quantita);
}

// ========== VERIFICA SIGLA ==========
router.get('/verifica-sigla', verifyToken, async (req, res) => {
  try {
    const { tipo_oggetto, oggetto_id, sigla_id, escludi_tipo, escludi_id } = req.query;
    if (!tipo_oggetto || !oggetto_id || !sigla_id) {
      return res.status(400).json({ success: false, message: 'Parametri mancanti' });
    }
    let query = `
      SELECT cs.destinazione_tipo, cs.destinazione_id, s.nome, s.cognome
      FROM carico_sintesi cs
      LEFT JOIN soggetti s ON s.tipo = cs.destinazione_tipo AND s.id = cs.destinazione_id
      WHERE cs.tipo_oggetto = ? AND cs.oggetto_id = ? AND cs.sigla_id = ? AND cs.quantita > 0
    `;
    const params = [tipo_oggetto, oggetto_id, sigla_id];
    if (escludi_tipo && escludi_id) {
      query += ' AND NOT (cs.destinazione_tipo = ? AND cs.destinazione_id = ?)';
      params.push(escludi_tipo, escludi_id);
    }
    const [rows] = await pool.query(query, params);
    if (rows.length === 0) {
      return res.json({ success: true, assegnato_a: null });
    }
    const row = rows[0];
    const nome = row.destinazione_tipo === 'PROMOTER' ? `${row.nome} ${row.cognome || ''}`.trim() : (row.nome || '');
    res.json({ success: true, assegnato_a: { tipo: row.destinazione_tipo, id: row.destinazione_id, nome } });
  } catch (error) {
    console.error('Errore in /verifica-sigla:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== RECUPERA SIGLE ==========
async function getSigleArticolo(articoloId) {
  try {
    const [rows] = await pool.query('SELECT id, sigla, durezza, lunghezza FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1', [articoloId]);
    return rows;
  } catch(e) {
    return [];
  }
}

async function getSigleKit(kitId) {
  try {
    const [sciRow] = await pool.query(
      `SELECT d.articolo_id FROM kit_dettaglio d WHERE d.kit_id = ? AND d.tipo_articolo = 'SCI' LIMIT 1`,
      [kitId]
    );
    if (!sciRow.length) return [];
    const articoloId = sciRow[0].articolo_id;
    const [rows] = await pool.query('SELECT id, sigla, durezza, lunghezza FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1', [articoloId]);
    return rows;
  } catch(e) {
    return [];
  }
}

// ========== OTTIENI OGGETTI IN CARICO ==========
async function getOggettiInCarico(destinazioneTipo, destinazioneId, magazzinoFiltro = null) {
  let query = `
    SELECT 
      cs.destinazione_tipo,
      cs.destinazione_id,
      cs.tipo_oggetto,
      cs.oggetto_id,
      cs.sigla_id,
      cs.quantita,
      cs.provenienza_tipo,
      cs.provenienza_id,
      cs.data_assegnazione,
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
        WHEN cs.tipo_oggetto = 'KIT' THEN (SELECT lunghezza FROM articoli WHERE articolo_id = (SELECT articolo_id FROM kit_dettaglio WHERE kit_id = k.id AND tipo_articolo = 'SCI' LIMIT 1))
      END AS LUNGHEZZA,
      CASE 
        WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.durezza
        WHEN cs.tipo_oggetto = 'KIT' THEN (SELECT durezza FROM articoli WHERE articolo_id = (SELECT articolo_id FROM kit_dettaglio WHERE kit_id = k.id AND tipo_articolo = 'SCI' LIMIT 1))
      END AS DUREZZA,
      (SELECT sigla FROM sigle_articoli WHERE id = cs.sigla_id) AS SIGLA_CORRENTE,
      sog.nome AS destinatario_nome,
      sog.cognome AS destinatario_cognome
    FROM carico_sintesi cs
    LEFT JOIN articoli a ON cs.tipo_oggetto = 'ARTICOLO' AND cs.oggetto_id = a.articolo_id
    LEFT JOIN kit k ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id
    LEFT JOIN soggetti sog ON sog.tipo = cs.destinazione_tipo AND sog.id = cs.destinazione_id
    WHERE cs.destinazione_tipo = ? AND cs.destinazione_id = ? AND cs.quantita > 0
  `;
  const params = [destinazioneTipo, destinazioneId];
  if (magazzinoFiltro) {
    query += ' AND (a.magazzino = ? OR k.magazzino = ?)';
    params.push(magazzinoFiltro, magazzinoFiltro);
  }
  const [rows] = await pool.query(query, params);
  
  const risultati = [];
  for (const row of rows) {
    let sigleDisponibili = [];
    if (row.tipo_oggetto === 'ARTICOLO') {
      sigleDisponibili = await getSigleArticolo(row.oggetto_id);
    } else if (row.tipo_oggetto === 'KIT') {
      sigleDisponibili = await getSigleKit(row.oggetto_id);
    }
    const destinatarioNome = row.destinazione_tipo === 'PROMOTER' ? `${row.destinatario_nome || ''} ${row.destinatario_cognome || ''}`.trim() : (row.destinatario_nome || '');
    risultati.push({
      tipo: row.tipo_oggetto,
      ID: row.oggetto_id,
      siglaId: row.sigla_id,
      descrizione: row.descrizione || '',
      codice: row.codice || '',
      quantita: row.quantita,
      LUNGHEZZA: row.LUNGHEZZA || '',
      DUREZZA: row.DUREZZA || '',
      SIGLA_CORRENTE: row.SIGLA_CORRENTE || '',
      destinazioneTipo: row.destinazione_tipo,
      destinazioneId: row.destinazione_id,
      destinatarioNome: destinatarioNome,
      sigleDisponibili: sigleDisponibili,
      provenienzaTipo: row.provenienza_tipo,
      provenienzaId: row.provenienza_id,
      dataAssegnazione: row.data_assegnazione
    });
  }
  return risultati;
}

// ========== REFERENTI RICORSIVI ==========
async function getSoggettiReferenziati(soggettoId) {
  const [diretti] = await pool.query('SELECT soggetto_id FROM soggetti_referenti WHERE referente_id = ?', [soggettoId]);
  let result = diretti.map(r => r.soggetto_id);
  for (const id of result) {
    const sub = await getSoggettiReferenziati(id);
    result = result.concat(sub);
  }
  return result;
}

async function getOggettiPerSoggettoConReferenti(tipo, id, magazzinoFiltro = null) {
  let oggetti = await getOggettiInCarico(tipo, id, magazzinoFiltro);
  oggetti = oggetti.map(o => ({ ...o, destinazioneTipo: tipo, destinazioneId: id, tipoAssegnazione: 'diretta', referenteDa: null }));
  
  const [referiti] = await pool.query('SELECT soggetto_id FROM soggetti_referenti WHERE referente_id = ?', [id]);
  for (const ref of referiti) {
    const [sog] = await pool.query('SELECT tipo FROM soggetti WHERE id = ?', [ref.soggetto_id]);
    if (sog.length === 0) continue;
    const tipoRef = sog[0].tipo;
    const oggettiRef = await getOggettiInCarico(tipoRef, ref.soggetto_id, magazzinoFiltro);
    oggetti.push(...oggettiRef.map(o => ({
      ...o,
      destinazioneTipo: tipoRef,
      destinazioneId: ref.soggetto_id,
      tipoAssegnazione: 'referente',
      referenteDa: { tipo: tipo, id: id }
    })));
  }
  return oggetti;
}

// ========== ROTTA OGGETTI (con referenti) ==========
router.post('/oggetti', verifyToken, async (req, res) => {
  try {
    const { magazzino, targetTipo, targetId, includeReferenced } = req.body;
    const userId = req.userId;

    const [userRows] = await pool.query('SELECT ruolo, riferimento_id FROM utenti WHERE id = ?', [userId]);
    if (userRows.length === 0) return res.status(404).json({ success: false, message: 'Utente non trovato' });
    const ruolo = userRows[0].ruolo;
    const userRiferimentoId = userRows[0].riferimento_id;

    if (ruolo === 'admin') {
      if (targetTipo && targetId) {
        let oggetti;
        if (includeReferenced) {
          oggetti = await getOggettiPerSoggettoConReferenti(targetTipo, targetId, magazzino);
        } else {
          oggetti = await getOggettiInCarico(targetTipo, targetId, magazzino);
          oggetti = oggetti.map(o => ({ ...o, destinazioneTipo: targetTipo, destinazioneId: targetId, tipoAssegnazione: 'me', referenteDa: null }));
        }
        return res.json({ success: true, oggetti });
      } else {
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
            (SELECT sigla FROM sigle_articoli WHERE id = cs.sigla_id) AS SIGLA_CORRENTE,
            sog.nome AS destinatario_nome,
            sog.cognome AS destinatario_cognome,
            a.lunghezza AS LUNGHEZZA,
            a.durezza AS DUREZZA
          FROM carico_sintesi cs
          LEFT JOIN articoli a ON cs.tipo_oggetto = 'ARTICOLO' AND cs.oggetto_id = a.articolo_id
          LEFT JOIN kit k ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id
          LEFT JOIN soggetti sog ON sog.tipo = cs.destinazione_tipo AND sog.id = cs.destinazione_id
          WHERE cs.quantita > 0
        `;
        const params = [];
        if (magazzino) {
          query += ' AND (a.magazzino = ? OR k.magazzino = ?)';
          params.push(magazzino, magazzino);
        }
        const [all] = await pool.query(query, params);
        const tutte = [];
        for (const row of all) {
          let sigleDisponibili = [];
          if (row.tipo_oggetto === 'ARTICOLO') {
            sigleDisponibili = await getSigleArticolo(row.oggetto_id);
          } else if (row.tipo_oggetto === 'KIT') {
            sigleDisponibili = await getSigleKit(row.oggetto_id);
          }
          const destinatarioNome = row.destinazione_tipo === 'PROMOTER' ? `${row.destinatario_nome || ''} ${row.destinatario_cognome || ''}`.trim() : (row.destinatario_nome || '');
          tutte.push({
            tipo: row.tipo_oggetto,
            ID: row.oggetto_id,
            siglaId: row.sigla_id,
            descrizione: row.descrizione || '',
            codice: row.codice || '',
            quantita: row.quantita,
            LUNGHEZZA: row.LUNGHEZZA || '',
            DUREZZA: row.DUREZZA || '',
            SIGLA_CORRENTE: row.SIGLA_CORRENTE || '',
            destinazioneTipo: row.destinazione_tipo,
            destinazioneId: row.destinazione_id,
            destinatarioNome: destinatarioNome,
            sigleDisponibili: sigleDisponibili,
            provenienzaTipo: row.provenienza_tipo,
            provenienzaId: row.provenienza_id,
            dataAssegnazione: row.data_assegnazione
          });
        }
        return res.json({ success: true, oggetti: tutte });
      }
    }

    // Non admin
    if (!userRiferimentoId) {
      return res.status(400).json({ success: false, message: 'Utente senza riferimento soggetto' });
    }
    const ruoloUtente = ruolo.toUpperCase();
    let oggetti = [];
    if (includeReferenced) {
      oggetti = await getOggettiPerSoggettoConReferenti(ruoloUtente, userRiferimentoId, magazzino);
    } else {
      oggetti = await getOggettiInCarico(ruoloUtente, userRiferimentoId, magazzino);
      oggetti = oggetti.map(o => ({ ...o, destinazioneTipo: ruoloUtente, destinazioneId: userRiferimentoId, tipoAssegnazione: 'me', referenteDa: null }));
    }
    res.json({ success: true, oggetti });
  } catch (error) {
    console.error('Errore in /oggetti:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== USCITA BATCH ==========
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
      if (!magazzinoId) throw new Error('Magazzino di partenza richiesto');
      await registraUscitaTransazionale(connection, {
        magazzinoId,
        tipoOggetto: item.tipoOggetto,
        oggettoId: item.oggettoId,
        siglaId: item.siglaId || null,
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

// ========== RIENTRO BATCH ==========
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
        siglaId: item.siglaId || null,
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

// ========== TRASFERIMENTO ==========
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
      // Rimuovi dal mittente (rientro)
      await registraRientroTransazionale(connection, {
        daTipo,
        daId,
        magazzinoId,
        tipoOggetto: item.tipoOggetto,
        oggettoId: item.oggettoId,
        siglaId: item.siglaId || null,
        quantita: item.quantita,
        note: note || `Trasferimento a ${aTipo} ${aId}`,
        operatore,
        userId: req.userId
      });
      // Aggiungi al destinatario (uscita) – con provenienza = mittente
      await aggiornaSintesiCarico(connection, aTipo, aId, item.tipoOggetto, item.oggettoId, item.siglaId || null, +item.quantita, daTipo, daId, new Date());
      // Registra movimento USCITA dal magazzino al destinatario (per tracciabilità)
      await connection.query(
        `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente, sigla_id)
         VALUES (NOW(), 'USCITA', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?, ?)`,
        [`MAGAZZINO-${magazzinoId}`, `${aTipo}-${aId}`, item.oggettoId, item.tipoOggetto, item.quantita, operatore, note || `Trasferimento da ${daTipo} ${daId}`, req.userId, item.siglaId || null]
      );
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

// ========== NUOVO ENDPOINT PER OGGETTI INVIATI (VELOCE) ==========
router.get('/inviati', verifyToken, async (req, res) => {
  try {
    const { provenienza_tipo, provenienza_id } = req.query;
    if (!provenienza_tipo || !provenienza_id) {
      return res.status(400).json({ error: 'provenienza_tipo e provenienza_id richiesti' });
    }
    const [rows] = await pool.query(`
      SELECT cs.*,
             CASE 
               WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.descrizione_completa
               WHEN cs.tipo_oggetto = 'KIT' THEN k.descrizione
             END AS descrizione,
             CASE 
               WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.codice
               WHEN cs.tipo_oggetto = 'KIT' THEN k.codice_kit
             END AS codice,
             a.lunghezza,
             a.durezza,
             (SELECT sigla FROM sigle_articoli WHERE id = cs.sigla_id) AS sigla,
             s.nome AS destinatario_nome,
             s.cognome AS destinatario_cognome
      FROM carico_sintesi cs
      LEFT JOIN articoli a ON cs.tipo_oggetto = 'ARTICOLO' AND cs.oggetto_id = a.articolo_id
      LEFT JOIN kit k ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id
      LEFT JOIN soggetti s ON s.tipo = cs.destinazione_tipo AND s.id = cs.destinazione_id
      WHERE cs.provenienza_tipo = ? AND cs.provenienza_id = ? AND cs.quantita > 0
      ORDER BY cs.data_assegnazione DESC
    `, [provenienza_tipo, provenienza_id]);
    
    const result = rows.map(row => ({
      ...row,
      destinatarioNome: row.destinazione_tipo === 'PROMOTER' ? `${row.destinatario_nome||''} ${row.destinatario_cognome||''}`.trim() : (row.destinatario_nome || 'Magazzino')
    }));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.registraUscitaTransazionale = registraUscitaTransazionale;
module.exports.registraRientroTransazionale = registraRientroTransazionale;
module.exports.aggiornaSintesiCarico = aggiornaSintesiCarico;