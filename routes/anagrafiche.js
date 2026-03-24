const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');

const router = express.Router();

// GET /api/anagrafiche/magazzini
router.get('/magazzini', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM magazzini WHERE attivo = true');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/anagrafiche/settori
router.get('/settori', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM settori WHERE attivo = true');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/anagrafiche/categorie
router.get('/categorie', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM categorie WHERE attivo = true');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/anagrafiche/marche
router.get('/marche', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM marche WHERE attivo = true');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/anagrafiche/menu
// Restituisce le voci di menu filtrate per ruolo e livello (se promoter)
router.get('/menu', verifyToken, async (req, res) => {
  try {
    // 1. Recupera l'utente loggato
    const [userRows] = await pool.query('SELECT * FROM utenti WHERE id = ?', [req.userId]);
    if (userRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Utente non trovato' });
    }
    const user = userRows[0];
    const ruolo = user.ruolo;
    const livello = user.livello;   // può essere NULL

    // 2. Recupera tutte le voci di menu ordinate
    const [menuRows] = await pool.query('SELECT * FROM menu_items ORDER BY ordine');

    // 3. Filtra le voci
    const allowed = menuRows.filter(item => {
      // Ruoli ammessi
      if (!item.ruoli) return false;
      const ruoliAmmessi = item.ruoli.split(',').map(r => r.trim());
      if (!ruoliAmmessi.includes(ruolo)) return false;

      // Se l'utente è promoter e la voce ha un filtro sul livello
      if (ruolo === 'promoter' && item.livelli && item.livelli.trim() !== '') {
        const livelliAmmessi = item.livelli.split(',').map(l => parseInt(l.trim()));
        // Se la lista dei livelli non è vuota e il livello dell'utente non è tra essi
        if (livelliAmmessi.length > 0 && !livelliAmmessi.includes(livello)) {
          return false;
        }
      }
      return true;
    });

    // 4. Restituisci i campi necessari al frontend
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