const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');

const router = express.Router();

// ---------- Helper: ottieni oggetti in carico da CARICO_SINTESI ----------
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
      END AS MAGAZZINO
    FROM carico_sintesi cs
    LEFT JOIN articoli a ON cs.tipo_oggetto = 'ARTICOLO' AND cs.oggetto_id = a.id
    LEFT JOIN kit k ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id
    LEFT JOIN articoli sci ON k.id_sci = sci.id
    WHERE cs.destinazione_tipo = ? AND cs.destinazione_id = ?
  `;
  const params = [destinazioneTipo, destinazioneId];
  if (magazzinoFiltro) {
    query += ' AND (a.magazzino = ? OR k.magazzino = ?)';
    params.push(magazzinoFiltro, magazzinoFiltro);
  }
  const [rows] = await pool.query(query, params);
  // Mappa al formato atteso dal frontend
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
    SCI_LUNGHEZZA: row.LUNGHEZZA || '', // per kit, la lunghezza dello sci
    SCI_DUREZZA: row.DUREZZA || '',
    MAGAZZINO: row.MAGAZZINO
  }));
}

// ---------- Helper: soggetti referenziati da agente ----------
async function getSoggettiByReferente(agenteId) {
  const [rows] = await pool.query(
    "SELECT * FROM soggetti WHERE (tipo = 'NEGOZIO' OR tipo = 'CLIENTE') AND FIND_IN_SET(?, referente)",
    [agenteId]
  );
  return rows;
}

// ---------- Helper: oggetti assegnati dall'utente (tramite movimenti) ----------
async function getOggettiAssegnatiDaUtente(userId, magazzinoFiltro = null) {
  // Prendi movimenti dove l'utente è operatore o promoter_mittente, e calcola netto per destinazione
  // Simile alla logica originale: netto = uscite - rientri per ogni (destinazione, oggetto)
  const [mov] = await pool.query(`
    SELECT 
      m.tipo,
      m.da_magazzino,
      m.a_magazzino,
      m.id_articolo_kit AS oggetto_id,
      m.tipo_oggetto,
      m.quantita,
      m.operatore,
      m.promoter_mittente
    FROM movimenti m
    WHERE m.stato = 'COMPLETATO'
      AND (m.operatore = (SELECT username FROM utenti WHERE id = ?) OR m.promoter_mittente = ?)
  `, [userId, userId]);
  
  const net = {};
  for (const row of mov) {
    const tipo = row.tipo;
    const da = row.da_magazzino;
    const a = row.a_magazzino;
    const oggettoId = row.oggetto_id;
    const tipoOggetto = row.tipo_oggetto;
    const quantita = row.quantita;
    let destinazione = null, idDest = null;
    if (tipo === 'USCITA') {
      const parts = a.split('-');
      if (parts.length >= 2) { destinazione = parts[0]; idDest = parts[1]; }
    } else if (tipo === 'RIENTRO') {
      const parts = da.split('-');
      if (parts.length >= 2) { destinazione = parts[0]; idDest = parts[1]; }
    }
    if (!destinazione || !idDest) continue;
    const key = `${destinazione}|${idDest}|${tipoOggetto}|${oggettoId}`;
    if (tipo === 'USCITA') net[key] = (net[key] || 0) + quantita;
    else if (tipo === 'RIENTRO') net[key] = (net[key] || 0) - quantita;
  }

  // Filtra e arricchisci
  const result = [];
  for (const [key, qta] of Object.entries(net)) {
    if (qta <= 0) continue;
    const [destTipo, destId, tipoOggetto, idOggetto] = key.split('|');
    // Ottieni dettagli dall'oggetto (articolo o kit)
    let dettagli = { descrizione: '', codice: '', LUNGHEZZA: '', DUREZZA: '', SIGLA: '', SCI_SIGLA: '', SCI_DESCRIZIONE: '', SCI_LUNGHEZZA: '', SCI_DUREZZA: '', MAGAZZINO: null };
    if (tipoOggetto === 'ARTICOLO') {
      const [art] = await pool.query('SELECT * FROM articoli WHERE id = ?', [idOggetto]);
      if (art.length) {
        const a = art[0];
        dettagli = {
          descrizione: a.descrizione_completa || a.descrizione || '',
          codice: a.codice || '',
          LUNGHEZZA: a.lunghezza || '',
          DUREZZA: a.durezza || '',
          SIGLA: a.sigla || '',
          MAGAZZINO: a.magazzino
        };
      }
    } else {
      const [kit] = await pool.query('SELECT * FROM kit WHERE id = ?', [idOggetto]);
      if (kit.length) {
        const k = kit[0];
        let sci = null;
        if (k.id_sci) {
          const [s] = await pool.query('SELECT * FROM articoli WHERE id = ?', [k.id_sci]);
          sci = s[0];
        }
        dettagli = {
          descrizione: k.descrizione || '',
          codice: k.codice_kit || '',
          LUNGHEZZA: sci ? sci.lunghezza : '',
          DUREZZA: sci ? sci.durezza : '',
          SIGLA: k.sigla || '',
          SCI_SIGLA: sci ? sci.sigla : '',
          SCI_DESCRIZIONE: sci ? sci.descrizione : '',
          SCI_LUNGHEZZA: sci ? sci.lunghezza : '',
          SCI_DUREZZA: sci ? sci.durezza : '',
          MAGAZZINO: k.magazzino
        };
      }
    }
    if (magazzinoFiltro && dettagli.MAGAZZINO != magazzinoFiltro) continue;
    result.push({
      tipo: tipoOggetto,
      ID: Number(idOggetto),
      ...dettagli,
      quantita: qta,
      destinazioneTipo: destTipo,
      destinazioneId: destId,
      tipoAssegnazione: 'altri'
    });
  }
  return result;
}

// ---------- Helper: aggiorna CARICO_SINTESI ----------
async function aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, variazione) {
  // Usa INSERT ... ON DUPLICATE KEY UPDATE
  const query = `
    INSERT INTO carico_sintesi (destinazione_tipo, destinazione_id, tipo_oggetto, oggetto_id, quantita)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE quantita = quantita + VALUES(quantita)
  `;
  await connection.query(query, [destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, variazione]);
  // Se dopo l'aggiornamento la quantità diventa 0, elimina la riga (opzionale)
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

// ---------- Operazioni transazionali ----------
async function registraUscitaTransazionale(connection, params) {
  const { magazzinoId, tipoOggetto, oggettoId, quantita, destinazioneTipo, destinazioneId, note, operatore, userId } = params;
  const now = new Date();
  // Verifica disponibilità (per articolo/kit)
  if (tipoOggetto === 'ARTICOLO') {
    const [art] = await connection.query('SELECT giacenza_reale FROM articoli WHERE id = ? FOR UPDATE', [oggettoId]);
    if (!art.length || art[0].giacenza_reale < quantita) throw new Error('Giacenza articolo insufficiente');
    await connection.query(
      'UPDATE articoli SET quantita_totale = quantita_totale - ?, data_modifica = NOW() WHERE id = ?',
      [quantita, oggettoId]
    );
  } else {
    const [kit] = await connection.query('SELECT quantita FROM kit WHERE id = ? FOR UPDATE', [oggettoId]);
    if (!kit.length || kit[0].quantita < quantita) throw new Error('Quantità kit insufficiente');
    await connection.query('UPDATE kit SET quantita = quantita - ?, data_modifica = NOW() WHERE id = ?', [quantita, oggettoId]);
  }
  // Inserisci movimento
  await connection.query(
    `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente)
     VALUES (NOW(), 'USCITA', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
    [`MAGAZZINO-${magazzinoId}`, `${destinazioneTipo}-${destinazioneId}`, oggettoId, tipoOggetto, quantita, operatore, note, userId]
  );
  // Aggiorna sintesi carico (aggiungi al destinatario)
  await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, +quantita);
}

async function registraRientroTransazionale(connection, params) {
  const { daTipo, daId, magazzinoId, tipoOggetto, oggettoId, quantita, note, operatore, userId } = params;
  // Aggiorna giacenza (rientro in magazzino)
  if (tipoOggetto === 'ARTICOLO') {
    await connection.query(
      'UPDATE articoli SET quantita_totale = quantita_totale + ?, data_modifica = NOW() WHERE id = ?',
      [quantita, oggettoId]
    );
  } else {
    await connection.query('UPDATE kit SET quantita = quantita + ?, data_modifica = NOW() WHERE id = ?', [quantita, oggettoId]);
  }
  // Inserisci movimento
  await connection.query(
    `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente)
     VALUES (NOW(), 'RIENTRO', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
    [`${daTipo}-${daId}`, `MAGAZZINO-${magazzinoId}`, oggettoId, tipoOggetto, quantita, operatore, note, userId]
  );
  // Aggiorna sintesi carico (rimuovi dal soggetto di provenienza)
  await aggiornaSintesiCarico(connection, daTipo, daId, tipoOggetto, oggettoId, -quantita);
}

// ---------- Route: ottieni oggetti per utente ----------
router.post('/oggetti', verifyToken, async (req, res) => {
  const { targetTipo, targetId, magazzino } = req.body;
  const userId = req.userId;
  try {
    // Ottieni utente
    const [userRows] = await pool.query('SELECT * FROM utenti WHERE id = ?', [userId]);
    if (!userRows.length) return res.status(404).json({ success: false, message: 'Utente non trovato' });
    const user = userRows[0];
    const ruolo = user.ruolo.toUpperCase();

    // Admin
    if (user.ruolo === 'admin') {
      if (targetTipo && targetId) {
        const oggetti = await getOggettiInCarico(targetTipo, targetId, magazzino);
        const [soggetto] = await pool.query('SELECT * FROM soggetti WHERE id = ?', [targetId]);
        let destinatarioNome = '';
        if (soggetto.length) {
          if (targetTipo === 'PROMOTER') destinatarioNome = (soggetto[0].nome + ' ' + soggetto[0].cognome).trim();
          else destinatarioNome = soggetto[0].nome || '';
        }
        const enriched = oggetti.map(o => ({ ...o, destinazioneTipo: targetTipo, destinazioneId: targetId, destinatarioNome, permettiGestione: true, tipoAssegnazione: 'me' }));
        return res.json({ success: true, oggetti: enriched });
      } else {
        // Per admin, tutte le assegnazioni (da CARICO_SINTESI)
        const [all] = await pool.query(`
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
            END AS MAGAZZINO
          FROM carico_sintesi cs
          LEFT JOIN articoli a ON cs.tipo_oggetto = 'ARTICOLO' AND cs.oggetto_id = a.id
          LEFT JOIN kit k ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id
          LEFT JOIN articoli sci ON k.id_sci = sci.id
          WHERE cs.quantita > 0
        `);
        // Arricchisci con nomi soggetti
        const soggettiMap = new Map();
        const [soggetti] = await pool.query('SELECT * FROM soggetti');
        soggetti.forEach(s => soggettiMap.set(`${s.tipo}|${s.id}`, s));
        const tutte = all.map(row => {
          const sog = soggettiMap.get(`${row.destinazione_tipo}|${row.destinazione_id}`);
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
            destinazioneTipo: row.destinazione_tipo,
            destinazioneId: row.destinazione_id,
            destinatarioNome: destinatarioNome
          };
        });
        if (magazzino) {
          return res.json({ success: true, oggetti: tutte.filter(o => o.MAGAZZINO == magazzino) });
        }
        return res.json({ success: true, oggetti: tutte });
      }
    }

    // Agente
    if (user.ruolo === 'agente') {
      const riferimentoId = user.riferimento_id;
      // 1. Oggetti in carico all'agente stesso
      const oggettiInCarico = await getOggettiInCarico(ruolo, riferimentoId, magazzino);
      // 2. Oggetti che l'agente ha assegnato ad altri
      const oggettiAssegnati = await getOggettiAssegnatiDaUtente(userId, magazzino);
      // 3. Oggetti in carico ai soggetti referenziati
      const soggettiReferenziati = await getSoggettiByReferente(riferimentoId);
      let oggettiInCaricoReferenziati = [];
      for (const sog of soggettiReferenziati) {
        const oggetti = await getOggettiInCarico(sog.tipo, sog.id, magazzino);
        oggettiInCaricoReferenziati.push(...oggetti.map(o => ({
          ...o,
          destinazioneTipo: sog.tipo,
          destinazioneId: sog.id,
          destinatarioNome: (sog.nome || '') + (sog.cognome ? ' ' + sog.cognome : ''),
          permettiGestione: false,
          tipoAssegnazione: 'referente'
        })));
      }
      // Arricchisci oggetti in carico all'agente
      const [sogAgente] = await pool.query('SELECT * FROM soggetti WHERE id = ?', [riferimentoId]);
      let destinatarioNomeCarico = '';
      if (sogAgente.length) {
        destinatarioNomeCarico = (sogAgente[0].nome || '') + (sogAgente[0].cognome ? ' ' + sogAgente[0].cognome : '');
      }
      const caricoEnriched = oggettiInCarico.map(o => ({ ...o, destinazioneTipo: ruolo, destinazioneId: riferimentoId, destinatarioNome: destinatarioNomeCarico, permettiGestione: true, tipoAssegnazione: 'me' }));
      const oggetti = [...caricoEnriched, ...oggettiAssegnati, ...oggettiInCaricoReferenziati];
      return res.json({ success: true, oggetti });
    }

    // Promoter o altri ruoli (simile a prima)
    const riferimentoId = user.riferimento_id;
    if (!riferimentoId) return res.status(400).json({ success: false, message: 'Utente senza riferimento' });
    const oggettiInCarico = await getOggettiInCarico(ruolo, riferimentoId, magazzino);
    const oggettiAssegnati = await getOggettiAssegnatiDaUtente(userId, magazzino);
    const [soggetto] = await pool.query('SELECT * FROM soggetti WHERE id = ?', [riferimentoId]);
    let destinatarioNomeCarico = '';
    if (soggetto.length) {
      if (ruolo === 'PROMOTER') destinatarioNomeCarico = (soggetto[0].nome + ' ' + soggetto[0].cognome).trim();
      else destinatarioNomeCarico = soggetto[0].nome || '';
    }
    const caricoEnriched = oggettiInCarico.map(o => ({ ...o, destinazioneTipo: ruolo, destinazioneId: riferimentoId, destinatarioNome: destinatarioNomeCarico, permettiGestione: true, tipoAssegnazione: 'me' }));
    // Arricchisci assegnati con nomi
    const soggettiMap = new Map();
    const [soggetti] = await pool.query('SELECT * FROM soggetti');
    soggetti.forEach(s => soggettiMap.set(`${s.tipo}|${s.id}`, s));
    const assegnatiEnriched = oggettiAssegnati.map(o => {
      const sog = soggettiMap.get(`${o.destinazioneTipo}|${o.destinazioneId}`);
      let destinatarioNome = '';
      if (sog) {
        if (o.destinazioneTipo === 'PROMOTER') destinatarioNome = (sog.nome + ' ' + sog.cognome).trim();
        else destinatarioNome = sog.nome || '';
      }
      return { ...o, destinatarioNome, permettiGestione: false };
    });
    const oggetti = [...caricoEnriched, ...assegnatiEnriched];
    res.json({ success: true, oggetti });
  } catch (error) {
    console.error('Errore in /oggetti:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------- Route: uscite multiple (assegnazioni dal magazzino) ----------
router.post('/uscita/batch', verifyToken, async (req, res) => {
  const { magazzinoId, destinazioneTipo, destinazioneId, note, oggetti } = req.body;
  if (!magazzinoId || !destinazioneTipo || !destinazioneId || !oggetti || !oggetti.length) {
    return res.status(400).json({ success: false, message: 'Parametri mancanti' });
  }
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const user = (await connection.query('SELECT * FROM utenti WHERE id = ?', [req.userId]))[0][0];
    for (const item of oggetti) {
      await registraUscitaTransazionale(connection, {
        magazzinoId,
        tipoOggetto: item.tipoOggetto,
        oggettoId: item.oggettoId,
        quantita: item.quantita,
        destinazioneTipo,
        destinazioneId,
        note,
        operatore: user.username,
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

// ---------- Route: rientri multipli (da soggetto a magazzino) ----------
router.post('/rientro/batch', verifyToken, async (req, res) => {
  const { magazzinoId, note, oggetti } = req.body; // ogni oggetto ha { tipoOggetto, oggettoId, quantita, daTipo?, daId? }
  if (!magazzinoId || !oggetti || !oggetti.length) {
    return res.status(400).json({ success: false, message: 'Parametri mancanti' });
  }
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const user = (await connection.query('SELECT * FROM utenti WHERE id = ?', [req.userId]))[0][0];
    for (const item of oggetti) {
      let daTipo, daId;
      if (item.daTipo && item.daId) {
        daTipo = item.daTipo;
        daId = item.daId;
      } else {
        // Se non specificato, usa il riferimento dell'utente (per promoter/agente)
        const [u] = await connection.query('SELECT * FROM utenti WHERE id = ?', [req.userId]);
        const ruolo = u[0].ruolo.toUpperCase();
        daTipo = ruolo;
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
        operatore: user.username,
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

// ---------- Route: trasferisci oggetto (da soggetto a soggetto) ----------
router.post('/trasferimento', verifyToken, async (req, res) => {
  const { daTipo, daId, oggettoId, tipoOggetto, quantita, destinazioneTipo, destinazioneId, note, magazzinoId } = req.body;
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const user = (await connection.query('SELECT * FROM utenti WHERE id = ?', [req.userId]))[0][0];
    // Rientro dal soggetto di partenza
    await registraRientroTransazionale(connection, {
      daTipo,
      daId,
      magazzinoId,
      tipoOggetto,
      oggettoId,
      quantita,
      note: note || 'Rientro per trasferimento',
      operatore: user.username,
      userId: req.userId
    });
    // Uscita verso nuovo soggetto
    await registraUscitaTransazionale(connection, {
      magazzinoId,
      tipoOggetto,
      oggettoId,
      quantita,
      destinazioneTipo,
      destinazioneId,
      note: note || 'Uscita per trasferimento',
      operatore: user.username,
      userId: req.userId
    });
    await connection.commit();
    res.json({ success: true, message: 'Trasferimento completato' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

// ---------- Route: richiama oggetto (da un soggetto a me) ----------
router.post('/richiamo', verifyToken, async (req, res) => {
  const { oggettoId, tipoOggetto, quantita, destinazioneTipo, destinazioneId } = req.body;
  if (!destinazioneTipo || !destinazioneId) {
    return res.status(400).json({ success: false, message: 'Origine dell\'oggetto non specificata' });
  }
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const user = (await connection.query('SELECT * FROM utenti WHERE id = ?', [req.userId]))[0][0];
    const mioRuolo = user.ruolo.toUpperCase();
    const mioRiferimentoId = user.riferimento_id;
    // Trova il magazzino dell'oggetto
    let magazzinoId;
    if (tipoOggetto === 'ARTICOLO') {
      const [art] = await connection.query('SELECT magazzino FROM articoli WHERE id = ?', [oggettoId]);
      if (!art.length) throw new Error('Articolo non trovato');
      magazzinoId = art[0].magazzino;
    } else {
      const [kit] = await connection.query('SELECT magazzino FROM kit WHERE id = ?', [oggettoId]);
      if (!kit.length) throw new Error('Kit non trovato');
      magazzinoId = kit[0].magazzino;
    }
    // Rientro dal soggetto di provenienza
    await registraRientroTransazionale(connection, {
      daTipo: destinazioneTipo,
      daId: destinazioneId,
      magazzinoId,
      tipoOggetto,
      oggettoId,
      quantita,
      note: `Richiamo da ${destinazioneTipo} ${destinazioneId}`,
      operatore: user.username,
      userId: req.userId
    });
    // Uscita verso il richiedente
    await registraUscitaTransazionale(connection, {
      magazzinoId,
      tipoOggetto,
      oggettoId,
      quantita,
      destinazioneTipo: mioRuolo,
      destinazioneId: mioRiferimentoId,
      note: `Richiamo verso ${mioRuolo} ${mioRiferimentoId}`,
      operatore: user.username,
      userId: req.userId
    });
    await connection.commit();
    res.json({ success: true, message: `Richiamati ${quantita} pezzi` });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

module.exports = router;