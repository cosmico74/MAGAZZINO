function testDestinatari() {
  const user = getUserById(8); // ID dell'agente
  const token = getSessionToken();
  const params = { tipo: 'NEGOZIO', userId: 8, token: token };
  const res = getDestinatariFiltrati(params);
  Logger.log(res);
}
// =============================================
// MENU E APERTURA MODALI
// =============================================

function onOpen() {
  try {
    const ui = SpreadsheetApp.getUi();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const configSheet = ss.getSheetByName('CONFIGURAZIONE');
    if (!configSheet) {
      ui.createMenu('🚀 INSTALLA SISTEMA')
        .addItem('🎯 INSTALLA SISTEMA MAGAZZINO', 'installaSistemaCompleto')
        .addItem('📖 MANUALE UTENTE', 'mostraManuale')
        .addToUi();
    } else {
      ui.createMenu('🏭 GESTIONE MAGAZZINO')
        .addItem('📋 APRI MENU PRINCIPALE', 'mostraMenuPrincipaleSidebar')
        .addSeparator()
        .addItem('📦 INSERISCI ARTICOLO', 'mostraMascheraInserimento')
        .addItem('📋 GESTIONE ARTICOLI', 'mostraGestioneArticoli')
        .addItem('🔖 ASSEGNA SIGLE', 'mostraAssegnaSigle')
        .addSeparator()
        .addItem('🔧 GESTISCI KIT', 'mostraMascheraKit')
        .addItem('🔧 CREA KIT DA ASSEGNATI', 'mostraCreaKitDaAssegnati')
        .addItem('🔓 SPACCHETTA KIT (MAGAZZINO)', 'mostraSpacchettaKitMagazzino')
        .addItem('🔓 SPACCHETTA KIT (ASSEGNATI)', 'mostraSpacchettaKitAssegnati')
        .addSeparator()
        .addItem('📤 ASSEGNAZIONI / TRASFERIMENTI', 'mostraAssegnazioniUnificate')
        .addSeparator()
        .addItem('📊 INVENTARIO', 'mostraInventario')
        .addSeparator()
        .addItem('🏭 GESTIONE MAGAZZINI', 'mostraGestioneMagazzini')
        .addItem('📋 GESTIONE SETTORI', 'mostraGestioneSettori')
        .addItem('🗂️ GESTIONE CATEGORIE', 'mostraGestioneCategorie')
        .addItem('🏷️ GESTIONE MARCHE', 'mostraGestioneMarche')
        .addItem('👥 GESTIONE SOGGETTI', 'mostraGestioneSoggetti')
        .addItem('👥 GESTIONE UTENTI', 'mostraGestioneUtentiCompleto')
        .addSeparator()
        .addItem('⚙️ CONFIGURAZIONI', 'mostraConfigurazioni')
        .addItem('🔧 INSTALLA/AGGIORNA SISTEMA', 'installaSistemaCompleto')
        .addToUi();
      mostraMenuPrincipaleSidebar();
    }
  } catch (error) {
    console.error('Errore in onOpen:', error);
  }
}

function mostraAssegnazioniUnificate() {
  const html = HtmlService.createHtmlOutputFromFile('AssegnazioniUnificate')
      .setWidth(1300)
      .setHeight(800);
  SpreadsheetApp.getUi().showModalDialog(html, '📦 Assegnazioni / Trasferimenti');
}

function mostraGestioneUtenti() {
  const html = HtmlService.createHtmlOutputFromFile('GestioneUtentiCompleto')
      .setWidth(1300)
      .setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '👥 Gestione Utenti');
}


function mostraGestioneSoggetti() {
  const html = HtmlService.createHtmlOutputFromFile('GestioneSoggetti').setWidth(1300).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '👥 Gestione Soggetti');
}
function mostraAssegnaSigle() {
  const html = HtmlService.createHtmlOutputFromFile('AssegnaSigle').setWidth(1100).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '🔖 Assegna Sigle a Sci');
}
function mostraPromoterDashboard() {
  const html = HtmlService.createHtmlOutputFromFile('PromoterDashboard').setWidth(1100).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '🔖 PERSONALE');
}
function mostraSpacchettaKitMagazzino() {
  const html = HtmlService.createHtmlOutputFromFile('SpacchettaKitMagazzino').setWidth(1100).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '🔓 Spacchetta Kit in Magazzino');
}
function mostraSpacchettaKitAssegnati() {
  const html = HtmlService.createHtmlOutputFromFile('SpacchettaKitAssegnati').setWidth(1100).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '🔓 Spacchetta Kit Assegnati');
}
function mostraCreaKitDaAssegnati() {
  const html = HtmlService.createHtmlOutputFromFile('CreaKitDaAssegnati').setWidth(1100).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '🔧 Crea Kit da Assegnati');
}
function mostraTrasferimentoVendita() {
  const html = HtmlService.createHtmlOutputFromFile('TrasferimentoVendita').setWidth(900).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '🔄 Trasferimento / Vendita');
}
function mostraMenuPrincipaleSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('MenuPrincipaleSidebar').setTitle('📋 Menu Gestionale').setWidth(320).setHeight(1200);
  SpreadsheetApp.getUi().showSidebar(html);
}
function mostraMenuPrincipale() {
  const html = HtmlService.createHtmlOutputFromFile('MenuPrincipale').setWidth(1100).setHeight(750);
  SpreadsheetApp.getUi().showModalDialog(html, '📋 Menu Gestionale');
}
function apriMascheraModale(nomeFile) {
  const titoli = {
    'InsertForm': '📦 Inserimento Articolo',
    'GestioneArticoli': '📋 Gestione Articoli',
    'KitForm': '🔧 Gestione Kit',
    'GestioneAssegnazioni': '📤 Assegnazione a Promoter/Negozi',
    'GestioneMagazzini': '🏭 Gestione Magazzini',
    'GestioneSettori': '📋 Gestione Settori',
    'GestioneCategorie': '🗂️ Gestione Categorie',
    'GestioneMarche': '🏷️ Gestione Marche',
    'Inventory': '📊 Inventario',
    'ReportAssegnazioni': '📋 Report Assegnazioni',
    'GestioneSoggetti': '👥 Gestione Soggetti',
    'ConfigForm': '⚙️ Configurazioni',
    'TrasferimentoVendita': '🔄 Trasferimento / Vendita'
  };
  const titolo = titoli[nomeFile] || 'Gestione';
  const html = HtmlService.createHtmlOutputFromFile(nomeFile).setWidth(1300).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, titolo);
}
function mostraMascheraInserimento() {
  const html = HtmlService.createHtmlOutputFromFile('InsertForm').setWidth(1300).setHeight(1500);
  SpreadsheetApp.getUi().showModalDialog(html, '📦 Inserimento Articolo');
}
function mostraMascheraKit() {
  const html = HtmlService.createHtmlOutputFromFile('KitForm').setWidth(1300).setHeight(1000);
  SpreadsheetApp.getUi().showModalDialog(html, '🔧 Gestione Kit');
}
function mostraMascheraMovimenti() {
  const html = HtmlService.createHtmlOutputFromFile('MoveForm').setWidth(1100).setHeight(800);
  SpreadsheetApp.getUi().showModalDialog(html, '🚚 Movimentazioni');
}
function mostraInventario() {
  const html = HtmlService.createHtmlOutputFromFile('Inventory').setWidth(1100).setHeight(800);
  SpreadsheetApp.getUi().showModalDialog(html, '📊 Inventario');
}
function mostraConfigurazioni() {
  const html = HtmlService.createHtmlOutputFromFile('ConfigForm').setWidth(900).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '⚙️ Configurazioni');
}
function mostraGestioneArticoli() {
  const html = HtmlService.createHtmlOutputFromFile('GestioneArticoli').setWidth(1200).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '📋 Gestione Articoli');
}
function mostraGestioneMagazzini() {
  const html = HtmlService.createHtmlOutputFromFile('GestioneMagazzini').setWidth(1000).setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, '🏭 Gestione Magazzini');
}
function mostraGestioneSettori() {
  const html = HtmlService.createHtmlOutputFromFile('GestioneSettori').setWidth(1000).setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, '📋 Gestione Settori');
}
function mostraGestioneCategorie() {
  const html = HtmlService.createHtmlOutputFromFile('GestioneCategorie').setWidth(1000).setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, '🗂️ Gestione Categorie');
}
function mostraGestioneMarche() {
  const html = HtmlService.createHtmlOutputFromFile('GestioneMarche').setWidth(1000).setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, '🏷️ Gestione Marche');
}
function mostraGestionePromoterNegozi() {
  const html = HtmlService.createHtmlOutputFromFile('GestioneSoggetti').setWidth(1300).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '👤 Gestione Soggetti');
}
function mostraAssegnazioni() {
  const html = HtmlService.createHtmlOutputFromFile('GestioneAssegnazioni').setWidth(900).setHeight(650);
  SpreadsheetApp.getUi().showModalDialog(html, '📤 Assegnazione a Promoter/Negozi');
}
function mostraReportAssegnazioni() {
  const html = HtmlService.createHtmlOutputFromFile('ReportAssegnazioni').setWidth(1100).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '📊 Report Assegnazioni');
}
function mostraAssegnatiEsterni() {
  const html = HtmlService.createHtmlOutputFromFile('AssegnatiEsterni').setWidth(1000).setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, 'Prodotti e Kit assegnati');
}
function mostraManuale() {
  const html = HtmlService.createHtmlOutput(
    '<div style="padding:20px;font-family:Arial;">' +
    '<h1>📖 Manuale Utente</h1>' +
    '<h3>Come installare il sistema:</h3>' +
    '<ol>' +
    '<li>Apri il Google Sheets</li>' +
    '<li>Vedi il menu <strong>"🚀 INSTALLA SISTEMA"</strong> in alto</li>' +
    '<li>Clicca su <strong>"🎯 INSTALLA SISTEMA MAGAZZINO"</strong></li>' +
    '<li>Conferma l\'installazione</li>' +
    '<li>Attendi qualche secondo</li>' +
    '<li>Il sistema creerà tutti i fogli necessari</li>' +
    '</ol>' +
    '<button onclick="google.script.host.close()" style="padding:10px 20px;background:#1a73e8;color:white;border:none;border-radius:5px;cursor:pointer;">Chiudi</button>' +
    '</div>'
  ).setWidth(700).setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, 'Manuale Utente');
}
function doGet() {
  return HtmlService.createHtmlOutputFromFile('PromoterDashboard').setTitle('I Miei Articoli').setWidth(900).setHeight(600);
}
function getHtmlFromFile(nomeFile) {
  return HtmlService.createHtmlOutputFromFile(nomeFile).getContent();
}
