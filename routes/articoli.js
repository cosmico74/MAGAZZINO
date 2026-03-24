const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');

const router = express.Router();

// Helper: genera codice articolo
function generateArticleCode(articleData, id) {
  // In una implementazione reale, potresti leggere categorie/marche dal DB
  // Qui facciamo una versione semplificata
  const categoriaNome = (articleData.categoriaNome || 'ART').substring(0, 3).toUpperCase();
  const marcaNome = (articleData.marcaNome || 'GEN').substring(0, 3).toUpperCase();
  let codice = `${categoriaNome}-${marcaNome}-${id.toString().padStart(4, '0')}`;
  if (articleData.lunghezza) codice += `-L${articleData.lunghezza}`;
  if (articleData.durezza) codice += `-D${articleData.durezza}`;
  return codice;
}

// Helper: descrizione completa
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

// GET /api/articoli?magazzino=...&settore=...&categoria=...&marca=...&search=...
router.get('/', verifyToken, async (req, res) => {
  try {
    let query = `
      SELECT a.*, 
             m.nome AS magazzino_nome,
             s.nome AS settore_nome,
             c.nome AS categoria_nome,
             mar.nome AS marca_nome
      FROM articoli a
      LEFT JOIN magazzini m ON a.magazzino = m.id
      LEFT JOIN settori s ON a.settore = s.id
      LEFT JOIN categorie c ON a.categoria = c.id
      LEFT JOIN marche mar ON a.marca = mar.id
      WHERE 1=1
    `;
    const params = [];
    if (req.query.magazzino) {
      query += ' AND a.magazzino = ?';
      params.push(req.query.magazzino);
    }
    if (req.query.settore) {
      query += ' AND a.settore = ?';
      params.push(req.query.settore);
    }
    if (req.query.categoria) {
      query += ' AND a.categoria = ?';
      params.push(req.query.categoria);
    }
    if (req.query.marca) {
      query += ' AND a.marca = ?';
      params.push(req.query.marca);
    }
    if (req.query.stato) {
      query += ' AND a.stato = ?';
      params.push(req.query.stato);
    }
    if (req.query.search) {
      query += ' AND (a.codice LIKE ? OR a.descrizione LIKE ? OR a.descrizione_completa LIKE ?)';
      const search = `%${req.query.search}%`;
      params.push(search, search, search);
    }
    const [rows] = await pool.query(query, params);
    // Calcola giacenza reale
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

// GET /api/articoli/:id
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM articoli WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Articolo non trovato' });
    }
    const articolo = rows[0];
    articolo.GIACENZA_REALE = (articolo.quantita_totale || 0) - (articolo.quantita_in_kit || 0);
    res.json(articolo);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/articoli (crea o aggiorna quantità)
router.post('/', verifyToken, async (req, res) => {
  const { id, codice, descrizione, magazzino, settore, categoria, marca,
          lunghezza, durezza, quantita, versione, stato, note, sigla, codiceModello } = req.body;
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const now = new Date();
    // Controlla se esiste già un articolo con gli stessi attributi
    const [existing] = await connection.query(`
      SELECT * FROM articoli 
      WHERE magazzino = ? AND settore = ? AND categoria = ? AND marca = ? 
        AND descrizione = ? AND lunghezza = ? AND durezza = ? 
        AND stato = 'Disponibile' AND (sigla = ? OR (sigla IS NULL AND ? IS NULL))
    `, [magazzino, settore, categoria, marca, descrizione, lunghezza || '', durezza || '', sigla || null, sigla || null]);
    
    if (existing.length > 0) {
      // Aggiorna quantità
      const art = existing[0];
      const nuovaQta = (art.quantita_totale || 0) + quantita;
      const descrizioneCompleta = buildDescrizioneCompleta(descrizione, lunghezza, durezza);
      await connection.query(`
        UPDATE articoli 
        SET quantita_totale = ?, descrizione_completa = ?, data_modifica = ?, note = ?
        WHERE id = ?
      `, [nuovaQta, descrizioneCompleta, now, note, art.id]);
      await connection.commit();
      return res.json({ success: true, message: `Quantità aggiornata: ${art.quantita_totale} → ${nuovaQta}`, id: art.id });
    }
    // Nuovo articolo: calcola prossimo ID e codice
    const [[{ maxId }]] = await connection.query('SELECT MAX(id) as maxId FROM articoli');
    const newId = (maxId || 0) + 1;
    const codiceGenerato = codice || generateArticleCode({ categoriaNome: '', marcaNome: '', lunghezza, durezza }, newId);
    const descrizioneCompleta = buildDescrizioneCompleta(descrizione, lunghezza, durezza);
    await connection.query(`
      INSERT INTO articoli 
      (id, codice, descrizione, descrizione_completa, magazzino, settore, categoria, marca, 
       lunghezza, durezza, quantita_totale, quantita_in_kit, versione, stato, 
       data_inserimento, data_modifica, note, quantita_obsoleta, sigla, codice_modello)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?)
    `, [newId, codiceGenerato, descrizione, descrizioneCompleta, magazzino, settore, categoria, marca,
        lunghezza || '', durezza || '', quantita, versione || '1.0', stato || 'Disponibile',
        now, now, note || '', sigla || null, codiceModello || null]);
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

// PUT /api/articoli/:id (aggiorna campi)
router.put('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { descrizione, lunghezza, durezza, quantita_totale, versione, stato, note, sigla, codiceModello } = req.body;
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query('SELECT * FROM articoli WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Articolo non trovato' });
    }
    const now = new Date();
    const descrizioneCompleta = buildDescrizioneCompleta(descrizione, lunghezza, durezza);
    await connection.query(`
      UPDATE articoli SET 
        descrizione = ?, descrizione_completa = ?, lunghezza = ?, durezza = ?,
        quantita_totale = ?, versione = ?, stato = ?, data_modifica = ?, note = ?,
        sigla = ?, codice_modello = ?
      WHERE id = ?
    `, [descrizione, descrizioneCompleta, lunghezza, durezza, quantita_totale, versione, stato, now, note, sigla, codiceModello, id]);
    await connection.commit();
    res.json({ success: true, message: 'Articolo aggiornato' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

// DELETE /api/articoli/:id
router.delete('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const connection = await pool.getConnection();
  try {
    const [result] = await connection.query('DELETE FROM articoli WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Articolo non trovato' });
    }
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