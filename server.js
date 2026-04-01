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