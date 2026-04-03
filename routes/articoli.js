const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');

// ========== HELPER PER VALORI DISTINTI ==========
async function getDistinctValues(field, req, res) {
  try {
    const { magazzino, settore, categoria, marca, descrizione, lunghezza, durezza, codice_modello } = req.query;
    let query = `SELECT DISTINCT ${field} FROM articoli WHERE ${field} IS NOT NULL AND ${field} != ''`;
    const params = [];
    if (magazzino) { query += ' AND magazzino = ?'; params.push(magazzino); }
    if (settore) { query += ' AND settore = ?'; params.push(settore); }
    if (categoria) { query += ' AND categoria = ?'; params.push(categoria); }
    if (marca) { query += ' AND marca = ?'; params.push(marca); }
    if (descrizione) { query += ' AND descrizione = ?'; params.push(descrizione); }
    if (lunghezza) { query += ' AND lunghezza = ?'; params.push(lunghezza); }
    if (durezza) { query += ' AND durezza = ?'; params.push(durezza); }
    if (codice_modello) { query += ' AND codice_modello = ?'; params.push(codice_modello); }
    query += ` ORDER BY ${field}`;
    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error(`Errore GET /valori/${field}:`, error);
    res.status(500).json({ error: error.message });
  }
}

// ========== ENDPOINTS PER I DATALIST ==========
router.get('/valori/descrizioni', verifyToken, async (req, res) => {
  await getDistinctValues('descrizione', req, res);
});
router.get('/valori/lunghezze', verifyToken, async (req, res) => {
  await getDistinctValues('lunghezza', req, res);
});
router.get('/valori/durezze', verifyToken, async (req, res) => {
  await getDistinctValues('durezza', req, res);
});
router.get('/valori/modelli', verifyToken, async (req, res) => {
  await getDistinctValues('codice_modello', req, res);
});

// Endpoint per le sigle: cerca nella tabella sigle_articoli
router.get('/valori/sigle', verifyToken, async (req, res) => {
  try {
    const { magazzino, settore, categoria, marca, descrizione, lunghezza, durezza, codice_modello } = req.query;
    let query = `
      SELECT DISTINCT s.sigla
      FROM sigle_articoli s
      JOIN articoli a ON s.articolo_id = a.articolo_id
      WHERE s.sigla IS NOT NULL AND s.sigla != ''
    `;
    const params = [];
    if (magazzino) { query += ' AND a.magazzino = ?'; params.push(magazzino); }
    if (settore) { query += ' AND a.settore = ?'; params.push(settore); }
    if (categoria) { query += ' AND a.categoria = ?'; params.push(categoria); }
    if (marca) { query += ' AND a.marca = ?'; params.push(marca); }
    if (descrizione) { query += ' AND a.descrizione = ?'; params.push(descrizione); }
    if (lunghezza) { query += ' AND a.lunghezza = ?'; params.push(lunghezza); }
    if (durezza) { query += ' AND a.durezza = ?'; params.push(durezza); }
    if (codice_modello) { query += ' AND a.codice_modello = ?'; params.push(codice_modello); }
    query += ' ORDER BY s.sigla';
    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Errore GET /valori/sigle:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== CRUD SIGLE ==========
// GET tutte le sigle di un articolo
router.get('/:id/sigle', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, sigla, lunghezza, durezza, codice_modello, note FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1 ORDER BY sigla',
      [req.params.id]
    );
    res.json(rows);
  } catch (error) {
    console.error('Errore GET /articoli/:id/sigle:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST nuova sigla per un articolo
router.post('/:id/sigle', verifyToken, async (req, res) => {
  const articoloId = req.params.id;
  const { sigla, lunghezza, durezza, codice_modello, note } = req.body;
  if (!sigla) return res.status(400).json({ error: 'La sigla è obbligatoria' });
  try {
    await db.query(
      `INSERT INTO sigle_articoli (articolo_id, sigla, lunghezza, durezza, codice_modello, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [articoloId, sigla, lunghezza || null, durezza || null, codice_modello || null, note || null]
    );
    res.json({ success: true, message: 'Sigla aggiunta' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Sigla già esistente per questo articolo' });
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT modifica una sigla
router.put('/sigle/:id', verifyToken, async (req, res) => {
  const { sigla, lunghezza, durezza, codice_modello, note } = req.body;
  try {
    await db.query(
      `UPDATE sigle_articoli SET sigla = ?, lunghezza = ?, durezza = ?, codice_modello = ?, note = ? WHERE id = ?`,
      [sigla, lunghezza || null, durezza || null, codice_modello || null, note || null, req.params.id]
    );
    res.json({ success: true, message: 'Sigla aggiornata' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE elimina una sigla
router.delete('/sigle/:id', verifyToken, async (req, res) => {
  try {
    await db.query('DELETE FROM sigle_articoli WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Sigla eliminata' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ========== CRUD ARTICOLI (invariata ma senza riferimenti a sigla nella tabella articoli) ==========
// Helper per generare codice e descrizione completa
function generateArticleCode(articleData, id) {
  const categoriaNome = (articleData.categoriaNome || 'ART').substring(0, 3).toUpperCase();
  const marcaNome = (articleData.marcaNome || 'GEN').substring(0, 3).toUpperCase();
  let codice = `${categoriaNome}-${marcaNome}-${id.toString().padStart(4, '0')}`;
  if (articleData.lunghezza) codice += `-L${articleData.lunghezza}`;
  if (articleData.durezza) codice += `-D${articleData.durezza}`;
  return codice;
}

function buildDescrizioneCompleta(descrizione, lunghezza, durezza) {
  const pulisci = (v) => (v === null || v === undefined || v === '') ? '' : String(v).trim();
  const d = pulisci(descrizione);
  const l = pulisci(lunghezza);
  const du = pulisci(durezza);
  let r = d;
  if (l !== '' && l !== '0') r = (r + ' ' + l).trim();
  if (du !== '' && du.toUpperCase() !== 'N/A') r = (r + ' ' + du).trim();
  return r;
}

router.get('/', verifyToken, async (req, res) => {
  try {
    let query = `
      SELECT a.articolo_id AS id, a.*, 
             m.nome AS magazzino_nome,
             s.nome AS settore_nome,
             c.nome AS categoria_nome,
             mar.nome AS marca_nome
      FROM articoli a
      LEFT JOIN magazzini m ON a.magazzino = m.magazzino_id
      LEFT JOIN settori s ON a.settore = s.settore_id
      LEFT JOIN categorie c ON a.categoria = c.categoria_id
      LEFT JOIN marche mar ON a.marca = mar.marca_id
      WHERE 1=1
    `;
    const params = [];
    if (req.query.magazzino) { query += ' AND a.magazzino = ?'; params.push(req.query.magazzino); }
    if (req.query.settore) { query += ' AND a.settore = ?'; params.push(req.query.settore); }
    if (req.query.categoria) { query += ' AND a.categoria = ?'; params.push(req.query.categoria); }
    if (req.query.marca) { query += ' AND a.marca = ?'; params.push(req.query.marca); }
    if (req.query.stato) { query += ' AND a.stato = ?'; params.push(req.query.stato); }
    if (req.query.descrizione) { query += ' AND a.descrizione LIKE ?'; params.push(`%${req.query.descrizione}%`); }
    if (req.query.codice_modello) { query += ' AND a.codice_modello LIKE ?'; params.push(`%${req.query.codice_modello}%`); }
    if (req.query.lunghezza) { query += ' AND a.lunghezza = ?'; params.push(req.query.lunghezza); }
    if (req.query.durezza) { query += ' AND a.durezza = ?'; params.push(req.query.durezza); }
    if (req.query.min_giacenza) { query += ' AND (a.quantita_totale - a.quantita_in_kit) >= ?'; params.push(req.query.min_giacenza); }
    if (req.query.search) {
      query += ' AND (a.codice LIKE ? OR a.descrizione LIKE ? OR a.descrizione_completa LIKE ?)';
      const search = `%${req.query.search}%`;
      params.push(search, search, search);
    }
    const [rows] = await db.query(query, params);
    const articoli = rows.map(a => ({
      ...a,
      GIACENZA_REALE: (a.quantita_totale || 0) - (a.quantita_in_kit || 0)
    }));
    res.json({ success: true, data: articoli });
  } catch (error) {
    console.error('Errore GET /articoli:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT articolo_id AS id, a.* FROM articoli a WHERE articolo_id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Articolo non trovato' });
    const articolo = rows[0];
    articolo.GIACENZA_REALE = (articolo.quantita_totale || 0) - (articolo.quantita_in_kit || 0);
    res.json(articolo);
  } catch (error) {
    console.error('Errore GET /articoli/:id:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/', verifyToken, async (req, res) => {
  const { id, codice, descrizione, magazzino, settore, categoria, marca,
          lunghezza, durezza, quantita, versione, stato, note, codiceModello } = req.body;
  const connection = await db.getConnection();
  await connection.beginTransaction();
  try {
    const now = new Date();
    const [existing] = await connection.query(`
      SELECT * FROM articoli 
      WHERE magazzino = ? AND settore = ? AND categoria = ? AND marca = ? 
        AND descrizione = ? AND lunghezza = ? AND durezza = ? 
        AND stato = 'Disponibile'
    `, [magazzino, settore, categoria, marca, descrizione, lunghezza || '', durezza || '']);
    
    if (existing.length > 0) {
      const art = existing[0];
      const nuovaQta = (art.quantita_totale || 0) + quantita;
      const descrizioneCompleta = buildDescrizioneCompleta(descrizione, lunghezza, durezza);
      const nuovaGiacenza = nuovaQta - (art.quantita_in_kit || 0);
      await connection.query(`
        UPDATE articoli 
        SET quantita_totale = ?, descrizione_completa = ?, data_modifica = ?, note = ?, giacenza_reale = ?
        WHERE articolo_id = ?
      `, [nuovaQta, descrizioneCompleta, now, note, nuovaGiacenza, art.articolo_id]);
      await connection.commit();
      return res.json({ success: true, message: `Quantità aggiornata: ${art.quantita_totale} → ${nuovaQta}`, id: art.articolo_id });
    }
    const [[{ maxId }]] = await connection.query('SELECT MAX(articolo_id) as maxId FROM articoli');
    const newId = (maxId || 0) + 1;
    const codiceGenerato = codice || generateArticleCode({ categoriaNome: '', marcaNome: '', lunghezza, durezza }, newId);
    const descrizioneCompleta = buildDescrizioneCompleta(descrizione, lunghezza, durezza);
    const giacenzaReale = quantita;
    await connection.query(`
      INSERT INTO articoli 
      (articolo_id, codice, descrizione, descrizione_completa, magazzino, settore, categoria, marca, 
       lunghezza, durezza, quantita_totale, quantita_in_kit, versione, stato, 
       data_inserimento, data_modifica, note, quantita_obsoleta, codice_modello, giacenza_reale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?)
    `, [newId, codiceGenerato, descrizione, descrizioneCompleta, magazzino, settore, categoria, marca,
        lunghezza || '', durezza || '', quantita, versione || '1.0', stato || 'Disponibile',
        now, now, note || '', codiceModello || null, giacenzaReale]);
    await connection.commit();
    res.json({ success: true, message: 'Articolo creato', id: newId, codice: codiceGenerato });
  } catch (error) {
    await connection.rollback();
    console.error('Errore POST /articoli:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

router.put('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { descrizione, lunghezza, durezza, quantita_totale, versione, stato, note, codiceModello,
          magazzino, settore, categoria, marca } = req.body;
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ? FOR UPDATE', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Articolo non trovato' });
    const old = rows[0];
    const now = new Date();
    const descrizioneCompleta = buildDescrizioneCompleta(descrizione, lunghezza, durezza);
    const nuovaGiacenza = quantita_totale - (old.quantita_in_kit || 0);
    await connection.query(`
      UPDATE articoli SET 
        descrizione = ?, descrizione_completa = ?, lunghezza = ?, durezza = ?,
        quantita_totale = ?, versione = ?, stato = ?, data_modifica = ?, note = ?,
        codice_modello = ?,
        magazzino = ?, settore = ?, categoria = ?, marca = ?, giacenza_reale = ?
      WHERE articolo_id = ?
    `, [descrizione, descrizioneCompleta, lunghezza, durezza, quantita_totale, versione, stato, now, note,
        codiceModello, magazzino, settore, categoria, marca, nuovaGiacenza, id]);
    await connection.commit();
    res.json({ success: true, message: 'Articolo aggiornato' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

router.delete('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const connection = await db.getConnection();
  try {
    const [result] = await connection.query('DELETE FROM articoli WHERE articolo_id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Articolo non trovato' });
    await connection.commit();
    res.json({ success: true, message: 'Articolo eliminato' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

module.exports = router;