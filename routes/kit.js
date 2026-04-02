const express = require('express');
const { verifyToken } = require('../auth');
const db = require('../db');
const { aggiornaSintesiCarico } = require('./assegnazioni');

const router = express.Router();

// GET all kits (con informazioni su eventuale assegnazione corrente)
router.get('/', verifyToken, async (req, res) => {
  try {
    const query = `
      SELECT k.*,
             cs.destinazione_tipo AS assegnato_tipo,
             cs.destinazione_id AS assegnato_id,
             cs.quantita AS assegnato_quantita,
             s.nome AS assegnato_nome,
             s.cognome AS assegnato_cognome
      FROM kit k
      LEFT JOIN carico_sintesi cs ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id AND cs.quantita > 0
      LEFT JOIN soggetti s ON s.tipo = cs.destinazione_tipo AND s.id = cs.destinazione_id
    `;
    const [rows] = await db.query(query);
    const kits = rows.map(k => ({
      ...k,
      assegnato_a: k.assegnato_tipo ? {
        tipo: k.assegnato_tipo,
        id: k.assegnato_id,
        nome: k.assegnato_tipo === 'PROMOTER' ? `${k.assegnato_nome} ${k.assegnato_cognome}`.trim() : k.assegnato_nome,
        quantita: k.assegnato_quantita   // <-- aggiunto
      } : null
    }));
    res.json(kits);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// GET single kit
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM kit WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Kit non trovato' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// POST create kit
router.post('/', verifyToken, async (req, res) => {
  const {
    magazzino, quantita, id_sci, id_attacchi, id_skistopper,
    sigla, note, componiDaAssegnati, sourceTipo, sourceId,
    destinazioneTipo, destinazioneId
  } = req.body;

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // 1. Se compone da oggetti assegnati, rientra i componenti dal soggetto sorgente al magazzino
    if (componiDaAssegnati) {
      if (!sourceTipo || !sourceId) {
        throw new Error('Per comporre da assegnati serve sourceTipo e sourceId');
      }
      const [mag] = await connection.query('SELECT magazzino_id FROM magazzini WHERE magazzino_id = ?', [magazzino]);
      if (!mag.length) throw new Error('Magazzino non trovato');

      // Usa la funzione registraRientroTransazionale (importata? Forse è meglio richiamare la funzione esportata da assegnazioni)
      const { registraRientroTransazionale } = require('./assegnazioni');
      await registraRientroTransazionale(connection, {
        daTipo: sourceTipo,
        daId: sourceId,
        magazzinoId: magazzino,
        tipoOggetto: 'ARTICOLO',
        oggettoId: id_sci,
        quantita: quantita,
        note: `Rientro per composizione kit (sci)`,
        operatore: req.userId,
        userId: req.userId
      });

      await registraRientroTransazionale(connection, {
        daTipo: sourceTipo,
        daId: sourceId,
        magazzinoId: magazzino,
        tipoOggetto: 'ARTICOLO',
        oggettoId: id_attacchi,
        quantita: quantita,
        note: `Rientro per composizione kit (attacchi)`,
        operatore: req.userId,
        userId: req.userId
      });

      if (id_skistopper) {
        await registraRientroTransazionale(connection, {
          daTipo: sourceTipo,
          daId: sourceId,
          magazzinoId: magazzino,
          tipoOggetto: 'ARTICOLO',
          oggettoId: id_skistopper,
          quantita: quantita,
          note: `Rientro per composizione kit (skistopper)`,
          operatore: req.userId,
          userId: req.userId
        });
      }
    }

    // 2. Consuma i componenti dal magazzino
    const consumaComponente = async (idComponente) => {
      const [art] = await connection.query(
        'SELECT (quantita_totale - quantita_in_kit) AS giacenza_reale FROM articoli WHERE articolo_id = ? FOR UPDATE',
        [idComponente]
      );
      if (!art.length || art[0].giacenza_reale < quantita) {
        throw new Error(`Giacenza insufficiente per articolo ${idComponente}`);
      }
      await connection.query(
        'UPDATE articoli SET quantita_totale = quantita_totale - ?, quantita_in_kit = quantita_in_kit + ? WHERE articolo_id = ?',
        [quantita, quantita, idComponente]
      );
    };

    await consumaComponente(id_sci);
    await consumaComponente(id_attacchi);
    if (id_skistopper) await consumaComponente(id_skistopper);

    // 3. Genera codice kit e descrizione
    const [maxSeqRow] = await connection.query(`
      SELECT MAX(CAST(SUBSTRING(codice_kit, LOCATE('-', codice_kit, LOCATE('-', codice_kit)+1)+1) AS UNSIGNED)) AS max_seq
      FROM kit
      WHERE magazzino = ?
    `, [magazzino]);
    const nextSeq = (maxSeqRow[0].max_seq || 0) + 1;
    const codiceKit = `KIT-${magazzino}-${nextSeq.toString().padStart(4, '0')}`;

    const [sci] = await connection.query('SELECT sigla, descrizione, lunghezza, durezza FROM articoli WHERE articolo_id = ?', [id_sci]);
    const [att] = await connection.query('SELECT sigla, descrizione FROM articoli WHERE articolo_id = ?', [id_attacchi]);
    let sk = null;
    if (id_skistopper) {
      [sk] = await connection.query('SELECT sigla, descrizione FROM articoli WHERE articolo_id = ?', [id_skistopper]);
    }

    const sciDisplay = `[${sci[0].sigla}] ${sci[0].descrizione} ${sci[0].lunghezza || ''} ${sci[0].durezza || ''}`.trim();
    const attDisplay = att[0].sigla ? `[${att[0].sigla}] ${att[0].descrizione}` : att[0].descrizione;
    const skDisplay = sk ? (sk[0].sigla ? `[${sk[0].sigla}] ${sk[0].descrizione}` : sk[0].descrizione) : null;
    let descrizioneKit = `Kit: ${sciDisplay} + ${attDisplay}`;
    if (skDisplay) descrizioneKit += ` + ${skDisplay}`;

    const [kitResult] = await connection.query(
      `INSERT INTO kit (codice_kit, descrizione, id_sci, id_attacchi, id_skistopper, quantita, magazzino, sigla, note, data_creazione, data_modifica)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        codiceKit, descrizioneKit,
        id_sci, id_attacchi, id_skistopper || null,
        quantita, magazzino,
        sigla || null, note || null
      ]
    );
    const kitId = kitResult.insertId;

    // 5. Se è stata specificata una destinazione finale, assegna il kit
    if (destinazioneTipo && destinazioneId) {
      const { registraUscitaTransazionale } = require('./assegnazioni');
      console.log(`[DEBUG] Assegnazione kit ID ${kitId} a ${destinazioneTipo} ${destinazioneId} con quantità ${quantita}`);
      await registraUscitaTransazionale(connection, {
        magazzinoId: magazzino,
        tipoOggetto: 'KIT',
        oggettoId: kitId,
        quantita: quantita,
        destinazioneTipo,
        destinazioneId,
        note: note || 'Assegnazione automatica da composizione kit',
        operatore: req.userId,
        userId: req.userId
      });
    }

    // 6. Registra movimento di composizione
    await connection.query(
      `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente)
       VALUES (NOW(), 'COMPOSIZIONE', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
      [`MAGAZZINO-${magazzino}`, `KIT-${kitId}`, kitId, 'KIT', quantita, req.userId, note || 'Composizione kit', req.userId]
    );

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

// PUT update kit
router.put('/:id', verifyToken, async (req, res) => {
  const { magazzino, quantita, id_sci, id_attacchi, id_skistopper, sigla, note } = req.body;
  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    const [kitRows] = await connection.query('SELECT * FROM kit WHERE id = ? FOR UPDATE', [req.params.id]);
    if (kitRows.length === 0) throw new Error('Kit non trovato');

    await connection.query(
      `UPDATE kit SET magazzino = ?, quantita = ?, id_sci = ?, id_attacchi = ?, id_skistopper = ?, sigla = ?, note = ?, data_modifica = NOW()
       WHERE id = ?`,
      [magazzino, quantita, id_sci, id_attacchi, id_skistopper || null, sigla || null, note || null, req.params.id]
    );

    await connection.commit();
    res.json({ success: true, message: 'Kit aggiornato' });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// DELETE kit
router.delete('/:id', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  await connection.beginTransaction();
  try {
    const [kitRows] = await connection.query('SELECT * FROM kit WHERE id = ? FOR UPDATE', [req.params.id]);
    if (kitRows.length === 0) throw new Error('Kit non trovato');
    // TODO: verificare che non sia assegnato (carico_sintesi) o eventualmente gestire
    await connection.query('DELETE FROM kit WHERE id = ?', [req.params.id]);
    await connection.commit();
    res.json({ success: true, message: 'Kit eliminato' });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ========== SPACCHETTAMENTO KIT ==========
router.post('/spacchetta', verifyToken, async (req, res) => {
  const { kitId, quantita, destinazioneTipo, destinazioneId } = req.body;
  if (!kitId || !quantita || !destinazioneTipo || !destinazioneId) {
    return res.status(400).json({ success: false, message: 'Parametri mancanti' });
  }

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // 1. Verifica che il kit sia assegnato al soggetto e che la quantità richiesta sia disponibile
    const [carico] = await connection.query(
      'SELECT quantita FROM carico_sintesi WHERE destinazione_tipo = ? AND destinazione_id = ? AND tipo_oggetto = "KIT" AND oggetto_id = ? FOR UPDATE',
      [destinazioneTipo, destinazioneId, kitId]
    );
    if (carico.length === 0) {
      throw new Error('Il kit non è assegnato al soggetto specificato');
    }
    if (carico[0].quantita < quantita) {
      throw new Error(`Quantità insufficiente: disponibili ${carico[0].quantita}, richieste ${quantita}`);
    }

    // 2. Ottieni i dettagli del kit
    const [kitRows] = await connection.query('SELECT * FROM kit WHERE id = ? FOR UPDATE', [kitId]);
    if (kitRows.length === 0) throw new Error('Kit non trovato');
    const kit = kitRows[0];
    if (kit.quantita < quantita) {
      throw new Error(`Kit ha quantità ${kit.quantita}, richieste ${quantita}`);
    }

    // 3. Recupera gli articoli componenti (sci, attacchi, skistopper)
    const [sciRow] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ? FOR UPDATE', [kit.id_sci]);
    const [attRow] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ? FOR UPDATE', [kit.id_attacchi]);
    let skRow = null;
    if (kit.id_skistopper) {
      [skRow] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ? FOR UPDATE', [kit.id_skistopper]);
    }

    if (!sciRow || !attRow) throw new Error('Componenti del kit non trovati');

    // 4. Riduci la quantità del kit nella sintesi carico
    const nuovaQuantitaCarico = carico[0].quantita - quantita;
    if (nuovaQuantitaCarico === 0) {
      await connection.query(
        'DELETE FROM carico_sintesi WHERE destinazione_tipo = ? AND destinazione_id = ? AND tipo_oggetto = "KIT" AND oggetto_id = ?',
        [destinazioneTipo, destinazioneId, kitId]
      );
    } else {
      await connection.query(
        'UPDATE carico_sintesi SET quantita = ? WHERE destinazione_tipo = ? AND destinazione_id = ? AND tipo_oggetto = "KIT" AND oggetto_id = ?',
        [nuovaQuantitaCarico, destinazioneTipo, destinazioneId, kitId]
      );
    }

    // 5. Aumenta la quantità degli articoli componenti nella sintesi carico (assegnali al soggetto)
    await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, 'ARTICOLO', kit.id_sci, +quantita);
    await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, 'ARTICOLO', kit.id_attacchi, +quantita);
    if (kit.id_skistopper) {
      await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, 'ARTICOLO', kit.id_skistopper, +quantita);
    }

    // 6. Aggiorna la tabella articoli: riduci quantita_in_kit
    await connection.query(
      'UPDATE articoli SET quantita_in_kit = quantita_in_kit - ? WHERE articolo_id = ?',
      [quantita, kit.id_sci]
    );
    await connection.query(
      'UPDATE articoli SET quantita_in_kit = quantita_in_kit - ? WHERE articolo_id = ?',
      [quantita, kit.id_attacchi]
    );
    if (kit.id_skistopper) {
      await connection.query(
        'UPDATE articoli SET quantita_in_kit = quantita_in_kit - ? WHERE articolo_id = ?',
        [quantita, kit.id_skistopper]
      );
    }

    // 7. Aggiorna la quantità del kit nella tabella kit
    const nuovaQuantitaKit = kit.quantita - quantita;
    if (nuovaQuantitaKit === 0) {
      await connection.query('DELETE FROM kit WHERE id = ?', [kitId]);
    } else {
      await connection.query('UPDATE kit SET quantita = ?, data_modifica = NOW() WHERE id = ?', [nuovaQuantitaKit, kitId]);
    }

    // 8. Registra un movimento di spacchettamento
    await connection.query(
      `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente)
       VALUES (NOW(), 'SPACCHETTAMENTO', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
      [`${destinazioneTipo}-${destinazioneId}`, `KIT-${kitId}`, kitId, 'KIT', quantita, req.userId, `Spacchettamento di ${quantita} kit per ${destinazioneTipo} ${destinazioneId}`, req.userId]
    );

    await connection.commit();
    res.json({ success: true, message: `Kit spacchettato con successo (${quantita} unità)` });
  } catch (err) {
    await connection.rollback();
    console.error('Errore spacchettamento kit:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

router.get('/', verifyToken, async (req, res) => {
  try {
    const query = `
      SELECT k.*,
             cs.destinazione_tipo AS assegnato_tipo,
             cs.destinazione_id AS assegnato_id,
             cs.quantita AS assegnato_quantita,
             s.nome AS assegnato_nome,
             s.cognome AS assegnato_cognome,
             sci.sigla AS sci_sigla
      FROM kit k
      LEFT JOIN carico_sintesi cs ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id AND cs.quantita > 0
      LEFT JOIN soggetti s ON s.tipo = cs.destinazione_tipo AND s.id = cs.destinazione_id
      LEFT JOIN articoli sci ON k.id_sci = sci.articolo_id
    `;
    const [rows] = await db.query(query);
    const kits = rows.map(k => ({
      ...k,
      sci_sigla: k.sci_sigla,
      assegnato_a: k.assegnato_tipo ? {
        tipo: k.assegnato_tipo,
        id: k.assegnato_id,
        nome: k.assegnato_tipo === 'PROMOTER' ? `${k.assegnato_nome} ${k.assegnato_cognome}`.trim() : k.assegnato_nome,
        quantita: k.assegnato_quantita
      } : null
    }));
    res.json(kits);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});
module.exports = router;