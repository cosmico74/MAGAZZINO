const { registraUscitaTransazionale, registraRientroTransazionale } = require('./assegnazioni');
const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');


// GET all kits (con informazioni su eventuale assegnazione corrente)
router.get('/', verifyToken, async (req, res) => {
  try {
    const query = `
      SELECT k.*,
             cs.destinazione_tipo AS assegnato_tipo,
             cs.destinazione_id AS assegnato_id,
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
        nome: k.assegnato_tipo === 'PROMOTER' ? `${k.assegnato_nome} ${k.assegnato_cognome}`.trim() : k.assegnato_nome
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
    // Ottieni il prossimo numero progressivo per il magazzino
    const [maxSeqRow] = await connection.query(`
      SELECT MAX(CAST(SUBSTRING(codice_kit, LOCATE('-', codice_kit, LOCATE('-', codice_kit)+1)+1) AS UNSIGNED)) AS max_seq
      FROM kit
      WHERE magazzino = ?
    `, [magazzino]);
    const nextSeq = (maxSeqRow[0].max_seq || 0) + 1;
    const codiceKit = `KIT-${magazzino}-${nextSeq.toString().padStart(4, '0')}`;

    // Ottieni i dettagli degli articoli per costruire la descrizione
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

    // 4. Inserisci kit
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

module.exports = router;