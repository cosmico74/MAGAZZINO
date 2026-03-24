const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Servi i file statici dalla cartella public
app.use(express.static(path.join(__dirname, 'public')));

// Importa le route (verifica che ogni file esporti un router Express)
const authRoutes = require('./routes/auth');
const anagraficheRoutes = require('./routes/anagrafiche');
const articoliRoutes = require('./routes/articoli');
const kitRoutes = require('./routes/kit');
const movimentiRoutes = require('./routes/movimenti');
const soggettiRoutes = require('./routes/soggetti');

// Debug: stampa il tipo di ogni modulo per identificare errori
console.log('authRoutes type:', typeof authRoutes);
console.log('anagraficheRoutes type:', typeof anagraficheRoutes);
console.log('articoliRoutes type:', typeof articoliRoutes);
console.log('kitRoutes type:', typeof kitRoutes);
console.log('movimentiRoutes type:', typeof movimentiRoutes);
console.log('soggettiRoutes type:', typeof soggettiRoutes);

// Utilizza le route solo se sono funzioni middleware
if (typeof authRoutes === 'function') app.use('/api/auth', authRoutes);
if (typeof anagraficheRoutes === 'function') app.use('/api/anagrafiche', anagraficheRoutes);
if (typeof articoliRoutes === 'function') app.use('/api/articoli', articoliRoutes);
if (typeof kitRoutes === 'function') app.use('/api/kit', kitRoutes);
if (typeof movimentiRoutes === 'function') app.use('/api/movimenti', movimentiRoutes);
if (typeof soggettiRoutes === 'function') app.use('/api/soggetti', soggettiRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));