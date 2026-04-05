const express = require('express');
const { verifyToken } = require('../auth');
const db = require('../db');
const { aggiornaSintesiCarico } = require('./assegnazioni');

const router = express.Router();

// Helper: consuma un articolo per un kit (aumenta solo quantita_in_kit)
// Consuma un articolo per un kit: aumenta solo quantita_in_kit (NON tocca quantita_totale)
async function consumaPerKit(connection, articoloId, quantita) {
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
    'UPDATE articoli SET quantita_in_kit = quantita_in_kit + ? WHERE articolo_id = ?',
    [quantita, articoloId]
  );
}

async function rilasciaDaKit(connection, articoloId, quantita) {
  await connection.query(
    'UPDATE articoli SET quantita_in_kit = quantita_in_kit - ? WHERE articolo_id = ?',
    [quantita, articoloId]
  );
}

// Rilascia un articolo da un kit: diminuisce quantita_in_kit (NON tocca quantita_totale)
async function rilasciaDaKit(connection, articoloId, quantita) {
  await connection.query(
    'UPDATE articoli SET quantita_in_kit = quantita_in_kit - ? WHERE articolo_id = ?',
    [quantita, articoloId]
  );
}

// Helper: rilascia un articolo da un kit (diminuisce quantita_in_kit)
async function rilasciaDaKit(connection, articoloId, quantita) {
  await connection.query(
    'UPDATE articoli SET quantita_in_kit = quantita_in_kit - ? WHERE articolo_id = ?',
    [quantita, articoloId]
  );
}

// GET all kits (con sigla associata)
router.get('/', verifyToken, async (req, res) => {
  try {
    const query = `
      SELECT k.*,
             cs.destinazione_tipo AS assegnato_tipo,
             cs.destinazione_id AS assegnato_id,
             cs.quantita AS assegnato_quantita,
             s.nome AS assegnato_nome,
             s.cognome AS assegnato_cognome,
             sig.sigla AS sci_sigla,
             sig.durezza AS sci_sigla_durezza,
             sig.lunghezza AS sci_sigla_lunghezza
      FROM kit k
      LEFT JOIN carico_sintesi cs ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id AND cs.quantita > 0
      LEFT JOIN soggetti s ON s.tipo = cs.destinazione_tipo AND s.id = cs.destinazione_id
      LEFT JOIN sigle_articoli sig ON k.sigla_id = sig.id
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

// POST create kit (con sigla_id)
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
    // Consuma i componenti (aumenta solo quantita_in_kit)
    await consumaPerKit(connection, id_sci, quantita);
    await consumaPerKit(connection, id_attacchi, quantita);
    if (id_skistopper) await consumaPerKit(connection, id_skistopper, quantita);

    // Genera codice kit
    const [maxSeqRow] = await connection.query(`
      SELECT MAX(CAST(SUBSTRING(codice_kit, LOCATE('-', codice_kit, LOCATE('-', codice_kit)+1)+1) AS UNSIGNED)) AS max_seq
      FROM kit
      WHERE magazzino = ?
    `, [magazzino]);
    const nextSeq = (maxSeqRow[0].max_seq || 0) + 1;
    const codiceKit = `KIT-${magazzino}-${nextSeq.toString().padStart(4, '0')}`;

    // Recupera dettagli sci (per descrizione)
    const [sci] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ?', [id_sci]);
    const sciLunghezza = sci[0].lunghezza;
    const sciDurezza = sci[0].durezza;
    const sciDescrizione = sci[0].descrizione;

    const [att] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ?', [id_attacchi]);
    const attDescrizione = att[0].descrizione;

    let skDescrizione = null;
    if (id_skistopper) {
      const [sk] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ?', [id_skistopper]);
      skDescrizione = sk[0].descrizione;
    }

    const sciDisplay = `${sciDescrizione} ${sciLunghezza || ''} ${sciDurezza || ''}`.trim();
    let descrizioneKit = `Kit: ${sciDisplay} + ${attDescrizione}`;
    if (skDescrizione) descrizioneKit += ` + ${skDescrizione}`;

    // Inserisci kit
    const [kitResult] = await connection.query(
      `INSERT INTO kit (codice_kit, descrizione, id_sci, id_attacchi, id_skistopper, quantita, magazzino, sigla_id, note, data_creazione, data_modifica)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        codiceKit, descrizioneKit,
        id_sci, id_attacchi, id_skistopper || null,
        quantita, magazzino,
        sigla_sci_id || null,
        note || null
      ]
    );
    const kitId = kitResult.insertId;

    // Assegnazione esterna se richiesta
    if (destinazioneTipo && destinazioneId) {
      await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, 'KIT', kitId, +quantita);
      await connection.query(
        `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, promoter_mittente)
         VALUES (NOW(), 'USCITA', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
        [`MAGAZZINO-${magazzino}`, `${destinazioneTipo}-${destinazioneId}`, kitId, 'KIT', quantita, req.userId, note || 'Assegnazione kit', req.userId]
      );
    }

    // Movimento di composizione
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

// PUT update kit (gestisce cambio componenti e quantità)
router.put('/:id', verifyToken, async (req, res) => {
  const { magazzino, quantita, id_sci, id_attacchi, id_skistopper, sigla_id, note } = req.body;
  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // 1. Recupera il kit esistente
    const [kitRows] = await connection.query('SELECT * FROM kit WHERE id = ? FOR UPDATE', [req.params.id]);
    if (kitRows.length === 0) throw new Error('Kit non trovato');
    const oldKit = kitRows[0];
    const nuovaQuantita = quantita || oldKit.quantita;

    // 2. Gestisci cambio componenti (rilascia vecchi, consuma nuovi)
    // Sci
    if (oldKit.id_sci !== id_sci) {
      await rilasciaDaKit(connection, oldKit.id_sci, oldKit.quantita);
      await consumaPerKit(connection, id_sci, nuovaQuantita);
    }
    // Attacchi
    if (oldKit.id_attacchi !== id_attacchi) {
      await rilasciaDaKit(connection, oldKit.id_attacchi, oldKit.quantita);
      await consumaPerKit(connection, id_attacchi, nuovaQuantita);
    }
    // Skistopper
    if (oldKit.id_skistopper !== id_skistopper) {
      if (oldKit.id_skistopper) await rilasciaDaKit(connection, oldKit.id_skistopper, oldKit.quantita);
      if (id_skistopper) await consumaPerKit(connection, id_skistopper, nuovaQuantita);
    }

    // 3. Gestisci variazione di quantità (se stesso kit, solo cambio quantità)
    if (oldKit.quantita !== nuovaQuantita && oldKit.id_sci === id_sci && oldKit.id_attacchi === id_attacchi && oldKit.id_skistopper === id_skistopper) {
      const diff = nuovaQuantita - oldKit.quantita;
      if (diff > 0) {
        await consumaPerKit(connection, id_sci, diff);
        await consumaPerKit(connection, id_attacchi, diff);
        if (id_skistopper) await consumaPerKit(connection, id_skistopper, diff);
      } else if (diff < 0) {
        await rilasciaDaKit(connection, id_sci, -diff);
        await rilasciaDaKit(connection, id_attacchi, -diff);
        if (id_skistopper) await rilasciaDaKit(connection, id_skistopper, -diff);
      }
    }

    // 4. Aggiorna il kit
    await connection.query(
      `UPDATE kit 
       SET magazzino = ?, quantita = ?, id_sci = ?, id_attacchi = ?, id_skistopper = ?, 
           sigla_id = ?, note = ?, data_modifica = NOW()
       WHERE id = ?`,
      [magazzino, nuovaQuantita, id_sci, id_attacchi, id_skistopper || null, sigla_id || null, note || null, req.params.id]
    );

    await connection.commit();
    res.json({ success: true, message: 'Kit aggiornato' });
  } catch (err) {
    await connection.rollback();
    console.error('Errore PUT /kit:', err);
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
    // Prima di eliminare, rilascia i componenti dal kit
    const [kit] = await connection.query('SELECT * FROM kit WHERE id = ? FOR UPDATE', [req.params.id]);
    if (kit.length) {
      await rilasciaDaKit(connection, kit[0].id_sci, kit[0].quantita);
      await rilasciaDaKit(connection, kit[0].id_attacchi, kit[0].quantita);
      if (kit[0].id_skistopper) await rilasciaDaKit(connection, kit[0].id_skistopper, kit[0].quantita);
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

// SPACCHETTAMENTO (restituisce i componenti al soggetto, rimuovendo dal kit)
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

    // Aggiungi componenti al carico del soggetto (non al magazzino)
    await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, 'ARTICOLO', kit.id_sci, +quantita);
    await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, 'ARTICOLO', kit.id_attacchi, +quantita);
    if (kit.id_skistopper) {
      await aggiornaSintesiCarico(connection, destinazioneTipo, destinazioneId, 'ARTICOLO', kit.id_skistopper, +quantita);
    }

    // IMPORTANTE: quando spacchetti, i componenti vengono tolti dal kit (quantita_in_kit diminuisce)
    await connection.query('UPDATE articoli SET quantita_in_kit = quantita_in_kit - ? WHERE articolo_id = ?', [quantita, kit.id_sci]);
    await connection.query('UPDATE articoli SET quantita_in_kit = quantita_in_kit - ? WHERE articolo_id = ?', [quantita, kit.id_attacchi]);
    if (kit.id_skistopper) {
      await connection.query('UPDATE articoli SET quantita_in_kit = quantita_in_kit - ? WHERE articolo_id = ?', [quantita, kit.id_skistopper]);
    }

    // Movimento di spacchettamento
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