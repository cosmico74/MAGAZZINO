const express = require('express');
const { verifyToken } = require('../auth');
const db = require('../db');
const { aggiornaSintesiCarico } = require('./assegnazioni');

const router = express.Router();

// ========== HELPER PER CONSUMO/RILASCIO ARTICOLI ==========
// Consuma un articolo per un kit (aumenta quantita_in_kit, aggiorna giacenza)
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

// Rilascia un articolo da un kit (diminuisce quantita_in_kit, aggiorna giacenza)
async function rilasciaArticolo(connection, articoloId, quantita) {
  await connection.query(
    `UPDATE articoli 
     SET quantita_in_kit = quantita_in_kit - ?, 
         giacenza_reale = quantita_totale - (quantita_in_kit - ?)
     WHERE articolo_id = ?`,
    [quantita, quantita, articoloId]
  );
}

// ========== GET all kits (con dettagli) ==========
router.get('/', verifyToken, async (req, res) => {
  try {
    // Prima prendi tutti i kit
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
    
    // Per ogni kit, recupera i dettagli
    const result = [];
    for (const kit of kits) {
      const [dettagli] = await db.query(`
        SELECT d.*, a.descrizione, sg.sigla
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
      SELECT d.*, a.descrizione, sg.sigla
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
  const { magazzino, note, destinazioneTipo, destinazioneId, dettagli } = req.body;
  if (!magazzino || !dettagli || !dettagli.length) {
    return res.status(400).json({ success: false, message: 'Dati incompleti (magazzino e almeno un componente)' });
  }

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // Genera codice kit
    const [maxSeqRow] = await connection.query(`
      SELECT MAX(CAST(SUBSTRING(codice_kit, LOCATE('-', codice_kit, LOCATE('-', codice_kit)+1)+1) AS UNSIGNED)) AS max_seq
      FROM kit WHERE magazzino = ?
    `, [magazzino]);
    const nextSeq = (maxSeqRow[0].max_seq || 0) + 1;
    const codiceKit = `KIT-${magazzino}-${nextSeq.toString().padStart(4, '0')}`;

    // Inserisci kit (intestazione)
    const [kitResult] = await connection.query(
      `INSERT INTO kit (codice_kit, descrizione, quantita, magazzino, note, data_creazione, data_modifica)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
      [codiceKit, '', 0, magazzino, note || null]
    );
    const kitId = kitResult.insertId;

    // Inserisci dettagli e consuma articoli
    let quantitaTotale = 0;
    for (const det of dettagli) {
      await consumaArticolo(connection, det.articolo_id, det.quantita);
      await connection.query(
        `INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita)
         VALUES (?, ?, ?, ?, ?)`,
        [kitId, det.tipo, det.articolo_id, det.sigla_id || null, det.quantita]
      );
      quantitaTotale += det.quantita;
    }

    // Aggiorna quantità totale kit
    await connection.query(`UPDATE kit SET quantita = ? WHERE id = ?`, [quantitaTotale, kitId]);

    // Assegnazione esterna (opzionale)
    if (destinazioneTipo && destinazioneId) {
      await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, 'KIT', kitId, quantitaTotale);
      await connection.query(
        `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente)
         VALUES (NOW(), 'USCITA', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
        [`MAGAZZINO-${magazzino}`, `${destinazioneTipo}-${destinazioneId}`, kitId, 'KIT', quantitaTotale, req.userId, note || 'Assegnazione kit', req.userId]
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
  const { magazzino, note, dettagli } = req.body;
  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // Recupera i dettagli attuali del kit
    const [oldDetails] = await connection.query(
      'SELECT * FROM kit_dettaglio WHERE kit_id = ? FOR UPDATE',
      [req.params.id]
    );

    // Crea mappe per confronto (chiave: tipo|articolo_id|sigla_id)
    const oldMap = new Map();
    for (const d of oldDetails) {
      const key = `${d.tipo_articolo}|${d.articolo_id}|${d.sigla_id || ''}`;
      oldMap.set(key, d);
    }
    const newMap = new Map();
    for (const d of dettagli) {
      const key = `${d.tipo}|${d.articolo_id}|${d.sigla_id || ''}`;
      newMap.set(key, d);
    }

    // Rilascia quelli rimossi o modificati in quantità
    for (const [key, old] of oldMap.entries()) {
      const newItem = newMap.get(key);
      if (!newItem) {
        // componente rimosso completamente
        await rilasciaArticolo(connection, old.articolo_id, old.quantita);
        await connection.query('DELETE FROM kit_dettaglio WHERE id = ?', [old.id]);
      } else if (old.quantita !== newItem.quantita) {
        const diff = old.quantita - newItem.quantita;
        if (diff > 0) {
          await rilasciaArticolo(connection, old.articolo_id, diff);
        } else {
          await consumaArticolo(connection, old.articolo_id, -diff);
        }
        await connection.query('UPDATE kit_dettaglio SET quantita = ? WHERE id = ?', [newItem.quantita, old.id]);
      }
    }

    // Aggiungi i nuovi componenti
    for (const [key, newItem] of newMap.entries()) {
      if (!oldMap.has(key)) {
        await consumaArticolo(connection, newItem.articolo_id, newItem.quantita);
        await connection.query(
          `INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita)
           VALUES (?, ?, ?, ?, ?)`,
          [req.params.id, newItem.tipo, newItem.articolo_id, newItem.sigla_id || null, newItem.quantita]
        );
      }
    }

    // Aggiorna intestazione kit
    const quantitaTotale = dettagli.reduce((sum, d) => sum + d.quantita, 0);
    await connection.query(
      `UPDATE kit SET magazzino = ?, note = ?, quantita = ?, data_modifica = NOW() WHERE id = ?`,
      [magazzino, note || null, quantitaTotale, req.params.id]
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