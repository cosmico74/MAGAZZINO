const express = require('express');
const { verifyToken } = require('../auth');
const db = require('../db');
const { aggiornaSintesiCarico } = require('./assegnazioni');

const router = express.Router();

// GET all kits
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
    magazzino, quantita, id_sci, sigla_sci_id,
    id_attacchi, sigla_attacchi_id,
    id_skistopper, sigla_skistopper_id,
    note, destinazioneTipo, destinazioneId
  } = req.body;

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // Consuma i componenti dal magazzino
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

    // Genera codice kit
    const [maxSeqRow] = await connection.query(`
      SELECT MAX(CAST(SUBSTRING(codice_kit, LOCATE('-', codice_kit, LOCATE('-', codice_kit)+1)+1) AS UNSIGNED)) AS max_seq
      FROM kit
      WHERE magazzino = ?
    `, [magazzino]);
    const nextSeq = (maxSeqRow[0].max_seq || 0) + 1;
    const codiceKit = `KIT-${magazzino}-${nextSeq.toString().padStart(4, '0')}`;

    // Recupera dettagli sci e sigla
    const [sci] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ?', [id_sci]);
    let sciSigla = null;
    let sciLunghezza = sci[0].lunghezza;
    let sciDurezza = sci[0].durezza;
    let sciDescrizione = sci[0].descrizione;
    if (sigla_sci_id) {
      const [siglaRow] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [sigla_sci_id]);
      if (siglaRow.length) {
        sciSigla = siglaRow[0].sigla;
        sciLunghezza = siglaRow[0].lunghezza || sciLunghezza;
        sciDurezza = siglaRow[0].durezza || sciDurezza;
      }
    }

    // Attacchi
    const [att] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ?', [id_attacchi]);
    let attSigla = null;
    if (sigla_attacchi_id) {
      const [siglaRow] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [sigla_attacchi_id]);
      if (siglaRow.length) attSigla = siglaRow[0].sigla;
    }

    // Skistopper
    let skSigla = null;
    if (id_skistopper) {
      const [sk] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ?', [id_skistopper]);
      if (sigla_skistopper_id) {
        const [siglaRow] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [sigla_skistopper_id]);
        if (siglaRow.length) skSigla = siglaRow[0].sigla;
      }
    }

    // Costruisci descrizione kit
    const sciDisplay = `${sciSigla ? `[${sciSigla}] ` : ''}${sciDescrizione} ${sciLunghezza || ''} ${sciDurezza || ''}`.trim();
    const attDisplay = attSigla ? `[${attSigla}] ${att[0].descrizione}` : att[0].descrizione;
    let descrizioneKit = `Kit: ${sciDisplay} + ${attDisplay}`;
    if (id_skistopper) {
      const skDesc = skSigla ? `[${skSigla}] ${sk[0].descrizione}` : sk[0].descrizione;
      descrizioneKit += ` + ${skDesc}`;
    }

    // Inserisci kit
    const [kitResult] = await connection.query(
      `INSERT INTO kit (codice_kit, descrizione, id_sci, id_attacchi, id_skistopper, quantita, magazzino, sigla, note, data_creazione, data_modifica)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        codiceKit, descrizioneKit,
        id_sci, id_attacchi, id_skistopper || null,
        quantita, magazzino,
        sciSigla || null,
        note || null
      ]
    );
    const kitId = kitResult.insertId;

    // Assegnazione esterna
    if (destinazioneTipo && destinazioneId) {
      await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, 'KIT', kitId, +quantita);
      await connection.query(
        `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente)
         VALUES (NOW(), 'USCITA', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
        [`MAGAZZINO-${magazzino}`, `${destinazioneTipo}-${destinazioneId}`, kitId, 'KIT', quantita, req.userId, note || 'Assegnazione kit', req.userId]
      );
    }

    // Movimento composizione
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
    const [assegnato] = await connection.query(
      'SELECT SUM(quantita) AS tot FROM carico_sintesi WHERE tipo_oggetto = "KIT" AND oggetto_id = ?',
      [req.params.id]
    );
    if (assegnato[0].tot > 0) {
      throw new Error('Impossibile eliminare: il kit è ancora assegnato a soggetti');
    }
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

// SPACCHETTAMENTO
router.post('/spacchetta', verifyToken, async (req, res) => {
  const { kitId, quantita, destinazioneTipo, destinazioneId } = req.body;
  if (!kitId || !quantita || !destinazioneTipo || !destinazioneId) {
    return res.status(400).json({ success: false, message: 'Parametri mancanti' });
  }

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    const [carico] = await connection.query(
      'SELECT quantita FROM carico_sintesi WHERE destinazione_tipo = ? AND destinazione_id = ? AND tipo_oggetto = "KIT" AND oggetto_id = ? FOR UPDATE',
      [destinazioneTipo, destinazioneId, kitId]
    );
    if (carico.length === 0) throw new Error('Kit non assegnato a questo soggetto');
    if (carico[0].quantita < quantita) throw new Error('Quantità insufficiente');

    const [kitRows] = await connection.query('SELECT * FROM kit WHERE id = ? FOR UPDATE', [kitId]);
    if (kitRows.length === 0) throw new Error('Kit non trovato');
    const kit = kitRows[0];

    // Riduci quantità nella sintesi carico
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

    // Aggiungi componenti al carico del soggetto
    await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, 'ARTICOLO', kit.id_sci, +quantita);
    await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, 'ARTICOLO', kit.id_attacchi, +quantita);
    if (kit.id_skistopper) {
      await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, 'ARTICOLO', kit.id_skistopper, +quantita);
    }

    // Aggiorna quantita_in_kit degli articoli
    await connection.query('UPDATE articoli SET quantita_in_kit = quantita_in_kit - ? WHERE articolo_id = ?', [quantita, kit.id_sci]);
    await connection.query('UPDATE articoli SET quantita_in_kit = quantita_in_kit - ? WHERE articolo_id = ?', [quantita, kit.id_attacchi]);
    if (kit.id_skistopper) {
      await connection.query('UPDATE articoli SET quantita_in_kit = quantita_in_kit - ? WHERE articolo_id = ?', [quantita, kit.id_skistopper]);
    }

    // Movimento
    await connection.query(
      `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente)
       VALUES (NOW(), 'SPACCHETTAMENTO', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
      [`${destinazioneTipo}-${destinazioneId}`, `KIT-${kitId}`, kitId, 'KIT', quantita, req.userId, `Spacchettamento di ${quantita} kit`, req.userId]
    );

    await connection.commit();
    res.json({ success: true, message: `Kit spacchettato (${quantita} unità)` });
  } catch (err) {
    await connection.rollback();
    console.error('Errore spacchettamento:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

module.exports = router;