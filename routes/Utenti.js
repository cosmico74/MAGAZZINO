// =============================================
// GESTIONE UTENTI (solo admin)
// =============================================

function getUtenti(params) {
  const token = params.token;
  const userId = params.userId;
  if (!isAdmin(token, userId)) return { success: false, message: 'Non autorizzato' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('UTENTI');
  if (!sheet) return { success: false, message: 'Foglio UTENTI non trovato' };
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const rows = data.slice(1);
  const utenti = rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
  return { success: true, data: utenti };
}

function saveUtente(params) {
  const token = params.token;
  const userId = params.userId;
  if (!isAdmin(token, userId)) return { success: false, message: 'Non autorizzato' };
  const { username, password, ruolo, riferimentoId, nomeVisualizzato, email } = params;
  if (!username) return { success: false, message: 'Username obbligatorio' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('UTENTI');
  if (!sheet) return { success: false, message: 'Foglio UTENTI non trovato' };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === username) return { success: false, message: 'Username già esistente' };
  }
  const { hash, salt } = hashPassword(password);
  const newId = sheet.getLastRow() + 1;
  const newRow = [
    newId,
    username,
    hash,
    salt,
    ruolo,
    riferimentoId || '',
    '',
    nomeVisualizzato || '',
    email || ''
  ];
  sheet.appendRow(newRow);
  invalidateRowCache(sheet);
  return { success: true, message: 'Utente creato con successo' };
}

function updateUtente(params) {
  const token = params.token;
  const userId = params.userId;
  if (!isAdmin(token, userId)) return { success: false, message: 'Non autorizzato' };
  const { id, username, password, ruolo, riferimentoId, nomeVisualizzato, email } = params;
  if (!id || !username) return { success: false, message: 'ID e username obbligatori' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('UTENTI');
  if (!sheet) return { success: false, message: 'Foglio UTENTI non trovato' };
  const rowIndex = findRowIndexById(sheet, id);
  if (rowIndex === -1) return { success: false, message: 'Utente non trovato' };
  sheet.getRange(rowIndex, 2).setValue(username);
  if (password) {
    const { hash, salt } = hashPassword(password);
    sheet.getRange(rowIndex, 3).setValue(hash);
    sheet.getRange(rowIndex, 4).setValue(salt);
  }
  sheet.getRange(rowIndex, 5).setValue(ruolo);
  sheet.getRange(rowIndex, 6).setValue(riferimentoId || '');
  sheet.getRange(rowIndex, 8).setValue(nomeVisualizzato || '');
  sheet.getRange(rowIndex, 9).setValue(email || '');
  invalidateRowCache(sheet);
  return { success: true, message: 'Utente aggiornato' };
}

function deleteUtente(params) {
  const token = params.token;
  const userId = params.userId;
  if (!isAdmin(token, userId)) return { success: false, message: 'Non autorizzato' };
  const { id } = params;
  if (!id) return { success: false, message: 'ID mancante' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('UTENTI');
  if (!sheet) return { success: false, message: 'Foglio UTENTI non trovato' };
  const rowIndex = findRowIndexById(sheet, id);
  if (rowIndex === -1) return { success: false, message: 'Utente non trovato' };
  sheet.deleteRow(rowIndex);
  invalidateRowCache(sheet);
  return { success: true, message: 'Utente eliminato' };
}