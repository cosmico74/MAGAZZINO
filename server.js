const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const { login } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Rotta di health check (utile per Render)
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// Rotta di login (NON protetta)
app.post('/api/auth/login', login);

// Importa e monta gli altri router
const anagraficheRoutes = require('./routes/anagrafiche');
const articoliRoutes = require('./routes/articoli');
const kitRoutes = require('./routes/kit');
const movimentiRoutes = require('./routes/movimenti');
const soggettiRoutes = require('./routes/soggetti');
const utentiRoutes = require('./routes/Utenti');
const assegnazioniRoutes = require('./routes/assegnazioni');

app.use('/api/anagrafiche', anagraficheRoutes);
app.use('/api/articoli', articoliRoutes);
app.use('/api/kit', kitRoutes);
app.use('/api/movimenti', movimentiRoutes);
app.use('/api/soggetti', soggettiRoutes);
app.use('/api/utenti', utentiRoutes);
app.use('/api/assegnazioni', assegnazioniRoutes);

// Gestione errori 404 per API
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint non trovato' });
});

// Gestione errori generici
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Errore interno del server' });
});

// Avvio server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server in esecuzione sulla porta ${PORT}`);
});