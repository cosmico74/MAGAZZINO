-- ------------------------------------------------------------
-- DATABASE: magazzino (o defaultdb su Aiven)
-- ------------------------------------------------------------

-- Tabella utenti
CREATE TABLE IF NOT EXISTS utenti (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(64) NOT NULL,
  salt VARCHAR(32) NOT NULL,
  ruolo ENUM('admin','promoter','negozio','cliente','agente') NOT NULL,
  riferimento_id INT,
  nome_visualizzato VARCHAR(100),
  email VARCHAR(100),
  livello INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabella soggetti
CREATE TABLE IF NOT EXISTS soggetti (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tipo ENUM('PROMOTER','NEGOZIO','CLIENTE','AGENTE') NOT NULL,
  nome VARCHAR(100),
  cognome VARCHAR(100),
  email VARCHAR(100),
  telefono VARCHAR(20),
  indirizzo VARCHAR(200),
  citta VARCHAR(100),
  cap VARCHAR(10),
  regione VARCHAR(100),
  referente VARCHAR(200),
  attivo BOOLEAN DEFAULT TRUE,
  note TEXT,
  livello INT
);

-- Magazzini
CREATE TABLE IF NOT EXISTS magazzini (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  indirizzo VARCHAR(200),
  responsabile VARCHAR(100),
  telefono VARCHAR(20),
  email VARCHAR(100),
  attivo BOOLEAN DEFAULT TRUE,
  note TEXT
);

-- Settori
CREATE TABLE IF NOT EXISTS settori (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  descrizione TEXT,
  magazzino_default INT,
  attivo BOOLEAN DEFAULT TRUE
);

-- Categorie
CREATE TABLE IF NOT EXISTS categorie (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  mostra_lunghezza ENUM('SI','NO') DEFAULT 'SI',
  mostra_durezza ENUM('SI','NO') DEFAULT 'SI',
  attivo BOOLEAN DEFAULT TRUE
);

-- Marche
CREATE TABLE IF NOT EXISTS marche (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  descrizione TEXT,
  sito_web VARCHAR(200),
  attivo BOOLEAN DEFAULT TRUE
);

-- Articoli
CREATE TABLE IF NOT EXISTS articoli (
  id INT AUTO_INCREMENT PRIMARY KEY,
  codice VARCHAR(50) NOT NULL,
  descrizione VARCHAR(200),
  descrizione_completa VARCHAR(300),
  magazzino INT,
  settore INT,
  categoria INT,
  marca INT,
  lunghezza VARCHAR(20),
  durezza VARCHAR(20),
  quantita_totale INT DEFAULT 0,
  quantita_in_kit INT DEFAULT 0,
  versione VARCHAR(20),
  stato ENUM('Disponibile','Esaurito','Sospeso') DEFAULT 'Disponibile',
  data_inserimento DATETIME,
  data_modifica DATETIME,
  note TEXT,
  quantita_obsoleta INT DEFAULT 0,
  sigla VARCHAR(50),
  codice_modello VARCHAR(50),
  FOREIGN KEY (magazzino) REFERENCES magazzini(id),
  FOREIGN KEY (settore) REFERENCES settori(id),
  FOREIGN KEY (categoria) REFERENCES categorie(id),
  FOREIGN KEY (marca) REFERENCES marche(id)
);

-- Kit
CREATE TABLE IF NOT EXISTS kit (
  id INT AUTO_INCREMENT PRIMARY KEY,
  codice_kit VARCHAR(50) NOT NULL,
  descrizione TEXT,
  id_sci INT,
  id_attacchi INT,
  id_skistopper INT,
  quantita INT DEFAULT 1,
  magazzino INT,
  stato ENUM('Disponibile','Esaurito') DEFAULT 'Disponibile',
  data_creazione DATETIME,
  data_modifica DATETIME,
  note TEXT,
  sigla VARCHAR(50),
  FOREIGN KEY (id_sci) REFERENCES articoli(id),
  FOREIGN KEY (id_attacchi) REFERENCES articoli(id),
  FOREIGN KEY (id_skistopper) REFERENCES articoli(id),
  FOREIGN KEY (magazzino) REFERENCES magazzini(id)
);

-- Movimenti
CREATE TABLE IF NOT EXISTS movimenti (
  id INT AUTO_INCREMENT PRIMARY KEY,
  data DATETIME NOT NULL,
  tipo ENUM('USCITA','RIENTRO') NOT NULL,
  da_magazzino VARCHAR(50),
  a_magazzino VARCHAR(50),
  id_articolo_kit INT,
  tipo_oggetto ENUM('ARTICOLO','KIT') NOT NULL,
  quantita INT NOT NULL,
  operatore VARCHAR(100),
  note TEXT,
  stato ENUM('COMPLETATO','PENDING') DEFAULT 'COMPLETATO',
  promoter_mittente INT,
  FOREIGN KEY (id_articolo_kit) REFERENCES articoli(id) ON DELETE SET NULL,
  FOREIGN KEY (promoter_mittente) REFERENCES utenti(id)
);

-- Carico sintesi
CREATE TABLE IF NOT EXISTS carico_sintesi (
  destinazione_tipo ENUM('PROMOTER','NEGOZIO','CLIENTE','AGENTE') NOT NULL,
  destinazione_id INT NOT NULL,
  tipo_oggetto ENUM('ARTICOLO','KIT') NOT NULL,
  oggetto_id INT NOT NULL,
  quantita INT NOT NULL,
  PRIMARY KEY (destinazione_tipo, destinazione_id, tipo_oggetto, oggetto_id),
  FOREIGN KEY (oggetto_id) REFERENCES articoli(id) ON DELETE CASCADE
);

-- Menu items
CREATE TABLE IF NOT EXISTS menu_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  titolo VARCHAR(100) NOT NULL,
  descrizione TEXT,
  icona VARCHAR(50),
  url VARCHAR(200) NOT NULL,
  ordine INT DEFAULT 0,
  ruoli VARCHAR(100) COMMENT 'Ruoli ammessi separati da virgola (admin,agente,promoter)',
  livelli VARCHAR(50) COMMENT 'Livelli ammessi separati da virgola (1,2,3)'
);

-- Inserimento voci di menu di esempio
INSERT INTO menu_items (titolo, descrizione, icona, url, ordine, ruoli, livelli) VALUES
('📦 Assegnazioni / Trasferimenti', 'Gestisci oggetti in carico, assegna dal magazzino, trasferisci tra soggetti.', '📦', '/AssegnazioniUnificate.html', 1, 'admin,agente,promoter', '1,2,3'),
('📋 Inserimento Articolo', 'Aggiungi un nuovo articolo al magazzino.', '➕', '/InsertForm.html', 2, 'admin', NULL),
('📋 Gestione Articoli', 'Visualizza, modifica o elimina articoli esistenti.', '📋', '/GestioneArticoli.html', 3, 'admin', NULL),
('🔧 Gestione Kit', 'Crea, modifica o elimina kit (sci + attacchi + skistopper).', '🔧', '/KitForm.html', 4, 'admin', NULL),
('🔧 Crea Kit da Assegnati', 'Componi un kit utilizzando articoli già in carico.', '🔨', '/CreaKitDaAssegnati.html', 5, 'admin,promoter', '1'),
('🔓 Spacchetta Kit (Magazzino)', 'Scompatta un kit direttamente in magazzino.', '📦➗', '/SpacchettaKitMagazzino.html', 6, 'admin', NULL),
('🔓 Spacchetta Kit (Assegnati)', 'Scompatta un kit già assegnato a un soggetto.', '📦➗', '/SpacchettaKitAssegnati.html', 7, 'admin,promoter', '1'),
('🏭 Gestione Magazzini', 'Crea, modifica o elimina magazzini.', '🏭', '/GestioneMagazzini.html', 8, 'admin', NULL),
('📋 Gestione Settori', 'Gestisci i settori merceologici.', '📂', '/GestioneSettori.html', 9, 'admin', NULL),
('🗂️ Gestione Categorie', 'Crea e modifica le categorie (sci, attacchi, ecc.).', '🏷️', '/GestioneCategorie.html', 10, 'admin', NULL),
('🏷️ Gestione Marche', 'Gestisci le marche (Kastle, ecc.).', '⭐', '/GestioneMarche.html', 11, 'admin', NULL),
('👥 Gestione Soggetti', 'Promoter, negozi, clienti, agenti.', '👥', '/GestioneSoggetti.html', 12, 'admin', NULL),
('👥 Gestione Utenti', 'Crea e gestisci gli utenti del sistema.', '🔐', '/GestioneUtenti.html', 13, 'admin', NULL),
('⚙️ Configurazioni', 'Impostazioni di sistema, hash password, migrazioni.', '⚙️', '/ConfigForm.html', 14, 'admin', NULL),
('📊 Inventario', 'Visualizza lo stato del magazzino (articoli e kit).', '📊', '/Inventory.html', 15, 'admin,agente,promoter', '1,2,3');

-- (Opzionale) Inserisci un utente admin di esempio (password: fanculo)
-- Esegui prima il file generateHash.js per ottenere salt e hash, poi sostituisci qui:
-- INSERT INTO utenti (username, password_hash, salt, ruolo, nome_visualizzato, email, livello) VALUES
-- ('admin', 'hash_ottenuto', 'salt_ottenuto', 'admin', 'Amministratore', 'admin@example.com', NULL);