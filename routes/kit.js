const express = require('express');
const { verifyToken } = require('../auth');
const db = require('../db');
const { aggiornaSintesiCarico } = require('./assegnazioni');

const router = express.Router();

// ========== HELPER PER CONSUMO/RILASCIO ARTICOLI ==========
// Consuma un articolo: aumenta quantita_in_kit, aggiorna giacenza_reale
async function consumaArticolo(connection, articoloId, quantita) {
  const [art] = await connection.query(
    'SELECT quantita_totale, quantita_in_kit FROM articoli WHERE articolo_id = ? FOR UPDATE',
    [articoloId]
  );
  if (!art.length) throw new Error(`Articolo ${articoloId} non trovato`);
  const disponibile = art[0].quantita_totale - art[0].quantita_in_kit;
  if (disponibile < quantita) {
    throw new Error(`Giacenza insufficiente per articolo ${articoloId} (disponibile ${disponibile})`);
  }
  await connection.query(
    `UPDATE articoli 
     SET quantita_in_kit = quantita_in_kit + ?, 
         giacenza_reale = quantita_totale - (quantita_in_kit + ?)
     WHERE articolo_id = ?`,
    [quantita, quantita, articoloId]
  );
}

// Rilascia un articolo: diminuisce quantita_in_kit, aggiorna giacenza_reale
async function rilasciaArticolo(connection, articoloId, quantita) {
  await connection.query(
    `UPDATE articoli 
     SET quantita_in_kit = quantita_in_kit - ?, 
         giacenza_reale = quantita_totale - (quantita_in_kit - ?)
     WHERE articolo_id = ?`,
    [quantita, quantita, articoloId]
  );
}

// ========== GET all kits (con dettagli raggruppati per kit) ==========
router.get('/', verifyToken, async (req, res) => {
  try {
    const [kits] = await db.query(`
      SELECT k.*, 
             cs.destinazione_tipo AS assegnato_tipo,
             cs.destinazione_id AS assegnato_id,
             cs.quantita AS assegnato_quantita,
             s.nome AS assegnato_nome,
             s.cognome AS assegnato_cognome
      FROM kit k
      LEFT JOIN carico_sintesi cs ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id AND cs.quantita > 0
      LEFT JOIN soggetti s ON s.tipo = cs.destinazione_tipo AND s.id = cs.destinazione_id
    `);
    
    const result = [];
    for (const kit of kits) {
      const [dettagli] = await db.query(`
        SELECT d.*, 
               a.descrizione AS articolo_descrizione,
               sg.sigla,
               sg.durezza AS sigla_durezza,
               sg.lunghezza AS sigla_lunghezza
        FROM kit_dettaglio d
        LEFT JOIN articoli a ON d.articolo_id = a.articolo_id
        LEFT JOIN sigle_articoli sg ON d.sigla_id = sg.id
        WHERE d.kit_id = ?
      `, [kit.id]);
      
      result.push({
        ...kit,
        dettagli: dettagli,
        assegnato_a: kit.assegnato_tipo ? {
          tipo: kit.assegnato_tipo,
          id: kit.assegnato_id,
          nome: kit.assegnato_tipo === 'PROMOTER' ? `${kit.assegnato_nome} ${kit.assegnato_cognome || ''}`.trim() : kit.assegnato_nome,
          quantita: kit.assegnato_quantita
        } : null
      });
    }
    res.json(result);
  } catch (err) {
    console.error('Errore GET /kit:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== GET single kit ==========
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [kitRows] = await db.query('SELECT * FROM kit WHERE id = ?', [req.params.id]);
    if (kitRows.length === 0) return res.status(404).json({ error: 'Kit non trovato' });
    const [dettagli] = await db.query(`
      SELECT d.*, 
             a.descrizione AS articolo_descrizione,
             sg.sigla,
             sg.durezza AS sigla_durezza,
             sg.lunghezza AS sigla_lunghezza
      FROM kit_dettaglio d
      LEFT JOIN articoli a ON d.articolo_id = a.articolo_id
      LEFT JOIN sigle_articoli sg ON d.sigla_id = sg.id
      WHERE d.kit_id = ?
    `, [req.params.id]);
    res.json({ ...kitRows[0], dettagli });
  } catch (err) {
    console.error('Errore GET /kit/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== POST create kit ==========
router.post('/', verifyToken, async (req, res) => {
  const { magazzino, sci_id, note, destinazioneTipo, destinazioneId, righe } = req.body;
  if (!magazzino || !sci_id || !righe || !righe.length) {
    return res.status(400).json({ success: false, message: 'Dati incompleti (magazzino, sci_id, almeno una riga)' });
  }

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // 1. Genera codice kit
    const [maxSeqRow] = await connection.query(`
      SELECT MAX(CAST(SUBSTRING(codice_kit, LOCATE('-', codice_kit, LOCATE('-', codice_kit)+1)+1) AS UNSIGNED)) AS max_seq
      FROM kit WHERE magazzino = ?
    `, [magazzino]);
    const nextSeq = (maxSeqRow[0].max_seq || 0) + 1;
    const codiceKit = `KIT-${magazzino}-${nextSeq.toString().padStart(4, '0')}`;

    // 2. Inserisci kit (intestazione)
    const [kitResult] = await connection.query(
      `INSERT INTO kit (codice_kit, descrizione, quantita, magazzino, note, data_creazione, data_modifica)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
      [codiceKit, '', 0, magazzino, note || null]
    );
    const kitId = kitResult.insertId;

    // 3. Per ogni riga, inserisci i componenti in kit_dettaglio e consuma gli articoli
    let quantitaTotaleKit = 0;
    for (const riga of righe) {
      const { sigla_id, attacco_id, skistopper_id, quantita } = riga;
      if (!sigla_id || !attacco_id) {
        throw new Error('Ogni riga deve avere sigla e attacco');
      }
      // Verifica che la sigla appartenga allo sci selezionato
      const [siglaCheck] = await connection.query(
        'SELECT articolo_id FROM sigle_articoli WHERE id = ?',
        [sigla_id]
      );
      if (!siglaCheck.length || siglaCheck[0].articolo_id !== sci_id) {
        throw new Error(`La sigla ID ${sigla_id} non appartiene allo sci selezionato`);
      }
      
      // Consuma lo sci (una unità per questa sigla)
      await consumaArticolo(connection, sci_id, quantita);
      // Consuma l'attacco
      await consumaArticolo(connection, attacco_id, quantita);
      // Consuma lo skistopper (se presente)
      if (skistopper_id) {
        await consumaArticolo(connection, skistopper_id, quantita);
      }
      
      // Inserisci riga per lo SCI (con sigla)
      await connection.query(
        `INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita)
         VALUES (?, 'SCI', ?, ?, ?)`,
        [kitId, sci_id, sigla_id, quantita]
      );
      // Inserisci riga per l'ATTACCO (senza sigla)
      await connection.query(
        `INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita)
         VALUES (?, 'ATTACCHI', ?, NULL, ?)`,
        [kitId, attacco_id, quantita]
      );
      // Inserisci riga per lo SKISTOPPER (se presente)
      if (skistopper_id) {
        await connection.query(
          `INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita)
           VALUES (?, 'SKISTOPPER', ?, NULL, ?)`,
          [kitId, skistopper_id, quantita]
        );
      }
      quantitaTotaleKit += quantita;
    }

    // 4. Aggiorna la quantità totale del kit
    await connection.query(`UPDATE kit SET quantita = ? WHERE id = ?`, [quantitaTotaleKit, kitId]);

    // 5. Assegnazione esterna (opzionale)
    if (destinazioneTipo && destinazioneId) {
      await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, 'KIT', kitId, quantitaTotaleKit);
      await connection.query(
        `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente)
         VALUES (NOW(), 'USCITA', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
        [`MAGAZZINO-${magazzino}`, `${destinazioneTipo}-${destinazioneId}`, kitId, 'KIT', quantitaTotaleKit, req.userId, note || 'Assegnazione kit', req.userId]
      );
    }

    await connection.commit();
    res.json({ success: true, message: 'Kit creato con successo', kitId });
  } catch (err) {
    await connection.rollback();
    console.error('Errore creazione kit:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ========== PUT update kit ==========
router.put('/:id', verifyToken, async (req, res) => {
  const { magazzino, sci_id, note, righe } = req.body;
  if (!magazzino || !sci_id || !righe || !righe.length) {
    return res.status(400).json({ success: false, message: 'Dati incompleti' });
  }

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // 1. Recupera il kit esistente e i suoi dettagli
    const [kitRows] = await connection.query('SELECT * FROM kit WHERE id = ? FOR UPDATE', [req.params.id]);
    if (kitRows.length === 0) throw new Error('Kit non trovato');
    
    // 2. Recupera i vecchi dettagli per rilasciare gli articoli
    const [oldDetails] = await connection.query(
      'SELECT * FROM kit_dettaglio WHERE kit_id = ?',
      [req.params.id]
    );
    
    // Rilascia tutti i vecchi componenti
    for (const det of oldDetails) {
      await rilasciaArticolo(connection, det.articolo_id, det.quantita);
    }
    
    // 3. Elimina le vecchie righe
    await connection.query('DELETE FROM kit_dettaglio WHERE kit_id = ?', [req.params.id]);
    
    // 4. Inserisci le nuove righe e consuma i nuovi articoli
    let quantitaTotaleKit = 0;
    for (const riga of righe) {
      const { sigla_id, attacco_id, skistopper_id, quantita } = riga;
      if (!sigla_id || !attacco_id) {
        throw new Error('Ogni riga deve avere sigla e attacco');
      }
      // Verifica che la sigla appartenga allo sci
      const [siglaCheck] = await connection.query(
        'SELECT articolo_id FROM sigle_articoli WHERE id = ?',
        [sigla_id]
      );
      if (!siglaCheck.length || siglaCheck[0].articolo_id !== sci_id) {
        throw new Error(`La sigla ID ${sigla_id} non appartiene allo sci selezionato`);
      }
      
      // Consuma i componenti
      await consumaArticolo(connection, sci_id, quantita);
      await consumaArticolo(connection, attacco_id, quantita);
      if (skistopper_id) {
        await consumaArticolo(connection, skistopper_id, quantita);
      }
      
      // Inserisci righe
      await connection.query(
        `INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita)
         VALUES (?, 'SCI', ?, ?, ?)`,
        [req.params.id, sci_id, sigla_id, quantita]
      );
      await connection.query(
        `INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita)
         VALUES (?, 'ATTACCHI', ?, NULL, ?)`,
        [req.params.id, attacco_id, quantita]
      );
      if (skistopper_id) {
        await connection.query(
          `INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita)
           VALUES (?, 'SKISTOPPER', ?, NULL, ?)`,
          [req.params.id, skistopper_id, quantita]
        );
      }
      quantitaTotaleKit += quantita;
    }
    
    // 5. Aggiorna intestazione kit
    await connection.query(
      `UPDATE kit SET magazzino = ?, note = ?, quantita = ?, data_modifica = NOW() WHERE id = ?`,
      [magazzino, note || null, quantitaTotaleKit, req.params.id]
    );
    
    await connection.commit();
    res.json({ success: true, message: 'Kit aggiornato con successo' });
  } catch (err) {
    await connection.rollback();
    console.error('Errore PUT /kit:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ========== DELETE kit ==========
router.delete('/:id', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  await connection.beginTransaction();
  try {
    // Rilascia tutti i componenti del kit
    const [dettagli] = await connection.query('SELECT * FROM kit_dettaglio WHERE kit_id = ?', [req.params.id]);
    for (const d of dettagli) {
      await rilasciaArticolo(connection, d.articolo_id, d.quantita);
    }
    await connection.query('DELETE FROM kit WHERE id = ?', [req.params.id]);
    await connection.commit();
    res.json({ success: true, message: 'Kit eliminato' });
  } catch (err) {
    await connection.rollback();
    console.error('Errore DELETE /kit:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

module.exports = router;