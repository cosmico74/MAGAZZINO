# Gestione Magazzino – Backend Node.js

Sistema completo per la gestione di magazzino, articoli, kit, movimenti e assegnazioni a promoter/negozi/clienti/agenti.  
Realizzato con **Node.js + Express + MySQL** e frontend in HTML/JS.

---

## 📁 Struttura del progetto
magazzino-api/
├── public/ # File HTML statici (interfaccia utente)
│ ├── AssegnazioniUnificate.html
│ ├── MenuPrincipale.html
│ ├── ConfigForm.html
│ ├── GestioneUtenti.html
│ ├── ... (altri file HTML)
├── routes/ # API endpoint
│ ├── auth.js # Login, token, livello
│ ├── anagrafiche.js # Magazzini, settori, categorie, marche, menu dinamico
│ ├── articoli.js # CRUD articoli
│ ├── kit.js # CRUD kit
│ ├── movimenti.js # Uscite, rientri, trasferimenti, richiami
│ └── soggetti.js # Gestione soggetti
├── server.js # Entry point
├── db.js # Connessione al database (pool)
├── auth.js # Middleware JWT (verifica token)
├── package.json
├── .env # Variabili d'ambiente (non versionato)
└── schema.sql # Script per creare le tabelle