const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');

const router = express.Router();

// GET /api/anagrafiche/magazzini
// Restituisce i magazzini visibili all'utente (admin → tutti, altrimenti filtrati tramite soggetti_magazzini)
router.get('/magazzini', verifyToken, async (req, res) => {
  try {
    // Recupera il ruolo e il riferimento dell'utente
    const [userRows] = await pool.query('SELECT ruolo, riferimento_id FROM utenti WHERE id = ?', [req.userId]);
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Utente non trovato' });
    }
    const user = userRows[0];
    const ruolo = user.ruolo;

    let query = 'SELECT magazzino_id AS id, nome FROM magazzini WHERE attivo = true ORDER BY nome';
    let params = [];

    // Se non è admin, filtra per i magazzini autorizzati tramite soggetti_magazzini
    if (ruolo !== 'admin') {
      if (!user.riferimento_id) {
        // Se l'utente non ha un riferimento, non vede nessun magazzino (ma restituiamo array vuoto)
        return res.json([]);
      }
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
    const [rows] = await pool.query(
      'SELECT settore_id AS id, nome FROM settori WHERE attivo = true ORDER BY nome'
    );
    res.json(rows);
  } catch (error) {
    console.error('Errore GET /settori:', error);
    res.status(500).json({ error: 'Errore caricamento settori' });
  }
});

// GET /api/anagrafiche/categorie
router.get('/categorie', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT categoria_id AS id, nome, mostra_lunghezza, mostra_durezza FROM categorie WHERE attivo = true ORDER BY nome'
    );
    res.json(rows);
  } catch (error) {
    console.error('Errore GET /categorie:', error);
    res.status(500).json({ error: 'Errore caricamento categorie' });
  }
});

// GET /api/anagrafiche/marche
router.get('/marche', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT marca_id AS id, nome FROM marche WHERE attivo = true ORDER BY nome'
    );
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
    if (userRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Utente non trovato' });
    }
    const user = userRows[0];
    const ruolo = user.ruolo;
    // Recupera il livello dal soggetto associato (se esiste)
    let livello = null;
    if (user.riferimento_id) {
      const [sog] = await pool.query('SELECT livello FROM soggetti WHERE id = ?', [user.riferimento_id]);
      if (sog.length) livello = sog[0].livello;
    }

    const [menuRows] = await pool.query('SELECT * FROM menu_items ORDER BY ordine');

    const allowed = menuRows.filter(item => {
      if (!item.ruoli) return false;
      const ruoliAmmessi = item.ruoli.split(',').map(r => r.trim());
      if (!ruoliAmmessi.includes(ruolo)) return false;

      // Se l'utente è promoter e la voce ha un filtro sul livello
      if (ruolo === 'promoter' && item.livelli && item.livelli.trim() !== '') {
        const livelliAmmessi = item.livelli.split(',').map(l => parseInt(l.trim()));
        // Se la lista non è vuota e il livello dell'utente non è tra essi
        if (livelliAmmessi.length > 0 && !livelliAmmessi.includes(livello)) {
          return false;
        }
      }
      return true;
    });

    const menuData = allowed.map(item => ({
      id: item.id,
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

module.exports = router;