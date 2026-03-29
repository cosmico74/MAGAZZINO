const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');

const router = express.Router();

// GET /api/anagrafiche/magazzini
router.get('/magazzini', verifyToken, async (req, res) => {
  try {
    const [userRows] = await pool.query('SELECT ruolo, riferimento_id FROM utenti WHERE id = ?', [req.userId]);
    if (userRows.length === 0) return res.status(404).json({ error: 'Utente non trovato' });
    const user = userRows[0];
    const ruolo = user.ruolo;

    let query = 'SELECT magazzino_id AS id, nome FROM magazzini WHERE attivo = true ORDER BY nome';
    let params = [];

    if (ruolo !== 'admin') {
      if (!user.riferimento_id) return res.json([]);
      query = `
        SELECT m.magazzino_id AS id, m.nome
        FROM magazzini m
        INNER JOIN soggetti_magazzini sm ON m.magazzino_id = sm.magazzino_id
        WHERE sm.soggetto_id = ? AND m.attivo = true
        ORDER BY m.nome
      `;
      params = [user.riferimento_id];
    }

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Errore GET /magazzini:', error);
    res.status(500).json({ error: 'Errore caricamento magazzini' });
  }
});

// GET /api/anagrafiche/settori
router.get('/settori', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT settore_id AS id, nome FROM settori WHERE attivo = true ORDER BY nome');
    res.json(rows);
  } catch (error) {
    console.error('Errore GET /settori:', error);
    res.status(500).json({ error: 'Errore caricamento settori' });
  }
});

// GET /api/anagrafiche/categorie
router.get('/categorie', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT categoria_id AS id, nome, mostra_lunghezza, mostra_durezza FROM categorie WHERE attivo = true ORDER BY nome');
    res.json(rows);
  } catch (error) {
    console.error('Errore GET /categorie:', error);
    res.status(500).json({ error: 'Errore caricamento categorie' });
  }
});

// GET /api/anagrafiche/marche
router.get('/marche', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT marca_id AS id, nome FROM marche WHERE attivo = true ORDER BY nome');
    res.json(rows);
  } catch (error) {
    console.error('Errore GET /marche:', error);
    res.status(500).json({ error: 'Errore caricamento marche' });
  }
});

// GET /api/anagrafiche/menu – restituisce i menu filtrati per ruolo e livello
router.get('/menu', verifyToken, async (req, res) => {
  try {
    const [userRows] = await pool.query('SELECT * FROM utenti WHERE id = ?', [req.userId]);
    if (userRows.length === 0) return res.status(404).json({ success: false, message: 'Utente non trovato' });
    const user = userRows[0];
    const ruolo = user.ruolo;
    let livello = null;
    if (user.riferimento_id) {
      const [sog] = await pool.query('SELECT livello FROM soggetti WHERE id = ?', [user.riferimento_id]);
      if (sog.length) livello = sog[0].livello;
    }

    // IMPORTANTE: uso l'alias 'settore_id AS id' per compatibilità con il frontend
    const [menuRows] = await pool.query('SELECT settore_id AS id, titolo, descrizione, icona, url, ordine, ruoli, livelli FROM menu_items ORDER BY ordine');

    const allowed = menuRows.filter(item => {
      if (!item.ruoli) return false;
      const ruoliAmmessi = item.ruoli.split(',').map(r => r.trim());
      if (!ruoliAmmessi.includes(ruolo)) return false;
      if (ruolo === 'promoter' && item.livelli && item.livelli.trim() !== '') {
        const livelliAmmessi = item.livelli.split(',').map(l => parseInt(l.trim()));
        if (livelliAmmessi.length > 0 && !livelliAmmessi.includes(livello)) return false;
      }
      return true;
    });

    const menuData = allowed.map(item => ({
      id: item.id,            // ora 'id' esiste perché abbiamo fatto l'alias
      titolo: item.titolo,
      descrizione: item.descrizione,
      icona: item.icona,
      url: item.url,
      ordine: item.ordine
    }));

    res.json(menuData);
  } catch (error) {
    console.error('Errore in /menu:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/anagrafiche/menu-items – per la gestione (admin)
router.get('/menu-items', verifyToken, async (req, res) => {
  try {
    // Restituisco anche l'ID reale (settore_id) come 'id' per semplicità, ma il frontend deve usare 'settore_id' oppure alias
    const [rows] = await pool.query('SELECT settore_id AS id, titolo, url, ordine, ruoli, livelli FROM menu_items ORDER BY ordine');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/anagrafiche/menu-items/:id – aggiorna ordine, ruoli, livelli
router.put('/menu-items/:id', verifyToken, async (req, res) => {
  const { id } = req.params;        // id = settore_id
  const { ordine, ruoli, livelli } = req.body;
  try {
    // Uso settore_id nella clausola WHERE
    await pool.query('UPDATE menu_items SET ordine = ?, ruoli = ?, livelli = ? WHERE settore_id = ?', [ordine, ruoli, livelli, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;