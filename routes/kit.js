const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');

const router = express.Router();

// Helper: genera codice kit
function generateKitCode(magazzinoId, id) {
  return `KIT-${magazzinoId}-${String(id).padStart(4, '0')}`;
}

// Helper: costruisce descrizione kit
async function buildKitDescription(kitData) {
  const [sci] = await pool.query('SELECT descrizione, sigla, lunghezza, durezza FROM articoli WHERE id = ?', [kitData.id_sci]);
  const [att] = await pool.query('SELECT descrizione, sigla FROM articoli WHERE id = ?', [kitData.id_attacchi]);
  let sciDesc = sci.length ? (sci[0].descrizione || '') : '';
  if (sci.length && sci[0].sigla) sciDesc = `[${sci[0].sigla}] ` + sciDesc;
  if (sci.length && sci[0].lunghezza) sciDesc += ' ' + sci[0].lunghezza;
  if (sci.length && sci[0].durezza && sci[0].durezza !== 'N/A') sciDesc += ' ' + sci[0].durezza;
  let attDesc = att.length ? (att[0].descrizione || '') : '';
  if (att.length && att[0].sigla) attDesc = `[${att[0].sigla}] ` + attDesc;
  let skDesc = '';
  if (kitData.id_skistopper) {
    const [sk] = await pool.query('SELECT descrizione, sigla FROM articoli WHERE id = ?', [kitData.id_skistopper]);
    if (sk.length) skDesc = (sk[0].sigla ? `[${sk[0].sigla}] ` : '') + (sk[0].descrizione || '');
  }
  return `Kit: ${sciDesc} + ${attDesc}` + (skDesc ? ` + ${skDesc}` : '');
}

// Helper: aggiorna quantità in kit (per articoli componenti)
async function updateArticoliForKit(connection, kitData, isCreation) {
  const segno = isCreation ? 1 : -1;
  const qta = kitData.quantita || 1;
  const ids = [kitData.id_sci, kitData.id_attacchi];
  if (kitData.id_skistopper) ids.push(kitData.id_skistopper);
  for (const id of ids) {
    if (!id) continue;
    const [rows] = await connection.query('SELECT quantita_in_kit FROM articoli WHERE id = ? FOR UPDATE', [id]);
    if (rows.length === 0) continue;
    const nuovaQtaKit = (rows[0].quantita_in_kit || 0) + (segno * qta);
    await connection.query('UPDATE articoli SET quantita_in_kit = ?, data_modifica = NOW() WHERE id = ?', [nuovaQtaKit, id]);
  }
}

// GET /api/kit?magazzino=...
router.get('/', verifyToken, async (req, res) => {
  try {
    let query = `
      SELECT k.*, 
             m.nome AS magazzino_nome,
             sci.descrizione AS sci_descrizione, sci.lunghezza AS sci_lunghezza, sci.durezza AS sci_durezza, sci.sigla AS sci_sigla
      FROM kit k
      LEFT JOIN magazzini m ON k.magazzino = m.id
      LEFT JOIN articoli sci ON k.id_sci = sci.id
      WHERE 1=1
    `;
    const params = [];
    if (req.query.magazzino) {
      query += ' AND k.magazzino = ?';
      params.push(req.query.magazzino);
    }
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/kit/:id
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM kit WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Kit non trovato' });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/kit (crea nuovo kit)
router.post('/', verifyToken, async (req, res) => {
  const { id_sci, id_attacchi, id_skistopper, quantita, magazzino, note, sigla } = req.body;
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    // Verifica disponibilità componenti
    const checkAvailability = async (id, type) => {
      const [art] = await connection.query('SELECT giacenza_reale FROM articoli WHERE id = ? FOR UPDATE', [id]);
      if (!art.length) throw new Error(`${type} non trovato`);
      if (art[0].giacenza_reale < quantita) throw new Error(`${type} disponibili: ${art[0].giacenza_reale}, richiesti: ${quantita}`);
    };
    await checkAvailability(id_sci, 'Sci');
    await checkAvailability(id_attacchi, 'Attacchi');
    if (id_skistopper) await checkAvailability(id_skistopper, 'Skistopper');

    // Genera nuovo ID e codice
    const [[{ maxId }]] = await connection.query('SELECT MAX(id) as maxId FROM kit');
    const newId = (maxId || 0) + 1;
    const codiceKit = generateKitCode(magazzino, newId);
    const descrizioneKit = await buildKitDescription({ id_sci, id_attacchi, id_skistopper });

    // Inserisci kit
    await connection.query(`
      INSERT INTO kit (id, codice_kit, descrizione, id_sci, id_attacchi, id_skistopper, quantita, magazzino, stato, data_creazione, data_modifica, note, sigla)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Disponibile', NOW(), NOW(), ?, ?)
    `, [newId, codiceKit, descrizioneKit, id_sci, id_attacchi, id_skistopper || null, quantita, magazzino, note || null, sigla || null]);

    // Aggiorna quantità in kit per i componenti
    await updateArticoliForKit(connection, { id_sci, id_attacchi, id_skistopper, quantita }, true);
    await connection.commit();
    res.json({ success: true, message: `Kit ${codiceKit} creato`, id: newId, codice: codiceKit });
  } catch (error) {
    await connection.rollback();
    console.error('Errore POST /kit:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

// PUT /api/kit/:id
router.put('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { id_sci, id_attacchi, id_skistopper, quantita, magazzino, note, sigla } = req.body;
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    // Recupera kit vecchio
    const [oldKit] = await connection.query('SELECT * FROM kit WHERE id = ? FOR UPDATE', [id]);
    if (oldKit.length === 0) throw new Error('Kit non trovato');
    const old = oldKit[0];
    const oldQta = old.quantita;
    const newQta = quantita || oldQta;

    // Rimuovi vecchie quantità dai componenti
    await updateArticoliForKit(connection, { id_sci: old.id_sci, id_attacchi: old.id_attacchi, id_skistopper: old.id_skistopper, quantita: oldQta }, false);
    // Aggiungi nuove quantità
    await updateArticoliForKit(connection, { id_sci, id_attacchi, id_skistopper, quantita: newQta }, true);

    const descrizioneKit = await buildKitDescription({ id_sci, id_attacchi, id_skistopper });
    await connection.query(`
      UPDATE kit SET 
        descrizione = ?, id_sci = ?, id_attacchi = ?, id_skistopper = ?,
        quantita = ?, magazzino = ?, data_modifica = NOW(), note = ?, sigla = ?
      WHERE id = ?
    `, [descrizioneKit, id_sci, id_attacchi, id_skistopper || null, newQta, magazzino, note || null, sigla || null, id]);

    await connection.commit();
    res.json({ success: true, message: 'Kit aggiornato' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

// DELETE /api/kit/:id
router.delete('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const [kit] = await connection.query('SELECT * FROM kit WHERE id = ? FOR UPDATE', [id]);
    if (kit.length === 0) throw new Error('Kit non trovato');
    // Rimuovi quantità dai componenti
    await updateArticoliForKit(connection, { id_sci: kit[0].id_sci, id_attacchi: kit[0].id_attacchi, id_skistopper: kit[0].id_skistopper, quantita: kit[0].quantita }, false);
    await connection.query('DELETE FROM kit WHERE id = ?', [id]);
    await connection.commit();
    res.json({ success: true, message: 'Kit eliminato' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

module.exports = router;