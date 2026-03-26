const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verifyToken } = require('../auth');

// Helper: converte una stringa "MAGAZZINO-2" o "PROMOTER-1" in un nome leggibile
async function parseDestinazione(destinazioneString, connection = null) {
  if (!destinazioneString) return 'Sconosciuta';
  const parts = destinazioneString.split('-');
  if (parts.length < 2) return destinazioneString;
  const tipo = parts[0];
  const id = parseInt(parts[1]);
  if (tipo === 'MAGAZZINO') {
    const [mag] = await pool.query('SELECT nome FROM magazzini WHERE magazzino_id = ?', [id]);
    if (mag && mag[0]) return `Magazzino ${mag[0].nome}`;
    return `Magazzino ${id}`;
  } else {
    const [sog] = await pool.query('SELECT nome, cognome FROM soggetti WHERE tipo = ? AND id = ?', [tipo, id]);
    if (sog && sog[0]) {
      if (tipo === 'PROMOTER') return `${tipo} ${sog[0].nome} ${sog[0].cognome || ''}`.trim();
      return `${tipo} ${sog[0].nome}`;
    }
    return `${tipo} ${id}`;
  }
}

// ---------- ROTTA: OTTIENI MOVIMENTI USCITA DI UN SOGGETTO ----------
router.get('/uscita/soggetto', verifyToken, async (req, res) => {
  try {
    const { provenienza_tipo, provenienza_id, magazzino, tipo_oggetto, data_da, data_a } = req.query;
    if (!provenienza_tipo || !provenienza_id) {
      return res.status(400).json({ success: false, message: 'Parametri provenienza_tipo e provenienza_id obbligatori' });
    }

    let sql = `
      SELECT 
        m.*,
        CASE 
          WHEN m.tipo_oggetto = 'ARTICOLO' THEN a.codice
          WHEN m.tipo_oggetto = 'KIT' THEN k.codice_kit
        END AS codice,
        CASE 
          WHEN m.tipo_oggetto = 'ARTICOLO' THEN a.descrizione
          WHEN m.tipo_oggetto = 'KIT' THEN k.descrizione
        END AS descrizione_oggetto
      FROM movimenti m
      LEFT JOIN articoli a ON m.tipo_oggetto = 'ARTICOLO' AND m.id_articolo_kit = a.articolo_id
      LEFT JOIN kit k ON m.tipo_oggetto = 'KIT' AND m.id_articolo_kit = k.id
      WHERE m.tipo = 'USCITA'
        AND m.provenienza_tipo = ? AND m.provenienza_id = ?
    `;
    const params = [provenienza_tipo, provenienza_id];

    if (magazzino) {
      sql += ' AND m.a_magazzino = ?';
      params.push(`MAGAZZINO-${magazzino}`);
    }
    if (tipo_oggetto) {
      sql += ' AND m.tipo_oggetto = ?';
      params.push(tipo_oggetto);
    }
    if (data_da) {
      sql += ' AND m.data >= ?';
      params.push(data_da);
    }
    if (data_a) {
      sql += ' AND m.data <= ?';
      params.push(data_a);
    }
    sql += ' ORDER BY m.data DESC';

    const [movimenti] = await pool.query(sql, params);

    // Arricchisci ogni movimento con il nome della destinazione (da a_magazzino)
    const risultati = [];
    for (const m of movimenti) {
      const destinazione = await parseDestinazione(m.a_magazzino);
      risultati.push({
        data: m.data,
        tipo_oggetto: m.tipo_oggetto,
        id_oggetto: m.id_articolo_kit,
        codice: m.codice || '-',
        descrizione: m.descrizione_oggetto || '-',
        quantita: m.quantita,
        destinazione,
        note: m.note || '-',
        provenienza_tipo: m.provenienza_tipo,
        provenienza_id: m.provenienza_id
      });
    }

    res.json({ success: true, data: risultati });
  } catch (err) {
    console.error('Errore in /movimenti/uscita/soggetto:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------- ROTTA: OTTIENI TUTTI I MOVIMENTI CON FILTRI ----------
router.get('/', verifyToken, async (req, res) => {
  try {
    let sql = `
      SELECT 
        m.*,
        CASE 
          WHEN m.tipo_oggetto = 'ARTICOLO' THEN a.codice
          WHEN m.tipo_oggetto = 'KIT' THEN k.codice_kit
        END AS codice,
        CASE 
          WHEN m.tipo_oggetto = 'ARTICOLO' THEN a.descrizione
          WHEN m.tipo_oggetto = 'KIT' THEN k.descrizione
        END AS descrizione_oggetto
      FROM movimenti m
      LEFT JOIN articoli a ON m.tipo_oggetto = 'ARTICOLO' AND m.id_articolo_kit = a.articolo_id
      LEFT JOIN kit k ON m.tipo_oggetto = 'KIT' AND m.id_articolo_kit = k.id
      WHERE 1=1
    `;
    const params = [];

    if (req.query.tipo) {
      sql += ' AND m.tipo = ?';
      params.push(req.query.tipo);
    }
    if (req.query.tipo_oggetto) {
      sql += ' AND m.tipo_oggetto = ?';
      params.push(req.query.tipo_oggetto);
    }
    if (req.query.da_magazzino) {
      sql += ' AND m.da_magazzino = ?';
      params.push(req.query.da_magazzino);
    }
    if (req.query.a_magazzino) {
      sql += ' AND m.a_magazzino = ?';
      params.push(req.query.a_magazzino);
    }
    if (req.query.provenienza_tipo && req.query.provenienza_id) {
      sql += ' AND m.provenienza_tipo = ? AND m.provenienza_id = ?';
      params.push(req.query.provenienza_tipo, req.query.provenienza_id);
    }
    if (req.query.destinazione_tipo && req.query.destinazione_id) {
      sql += ' AND m.destinazione_tipo = ? AND m.destinazione_id = ?';
      params.push(req.query.destinazione_tipo, req.query.destinazione_id);
    }
    if (req.query.id_articolo_kit) {
      sql += ' AND m.id_articolo_kit = ?';
      params.push(req.query.id_articolo_kit);
    }
    if (req.query.data_da) {
      sql += ' AND m.data >= ?';
      params.push(req.query.data_da);
    }
    if (req.query.data_a) {
      sql += ' AND m.data <= ?';
      params.push(req.query.data_a);
    }
    if (req.query.operatore) {
      sql += ' AND m.operatore = ?';
      params.push(req.query.operatore);
    }

    sql += ' ORDER BY m.data DESC';
    const [movimenti] = await pool.query(sql, params);

    // Arricchisci con nomi leggibili (opzionale)
    const risultati = [];
    for (const m of movimenti) {
      const destinazione = m.a_magazzino ? await parseDestinazione(m.a_magazzino) : null;
      const provenienza = m.da_magazzino ? await parseDestinazione(m.da_magazzino) : null;
      risultati.push({
        ...m,
        codice: m.codice || '-',
        descrizione_oggetto: m.descrizione_oggetto || '-',
        destinazione_nome: destinazione,
        provenienza_nome: provenienza
      });
    }

    res.json({ success: true, data: risultati });
  } catch (err) {
    console.error('Errore in GET /movimenti:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;