const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pool = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Token non fornito' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: 'Token non valido' });
  }
};

const login = async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username e password richiesti' });
  }
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.password_hash, u.ruolo, u.riferimento_id, u.nome_visualizzato, u.email,
              s.livello
       FROM utenti u
       LEFT JOIN soggetti s ON u.riferimento_id = s.id
       WHERE u.username = ?`,
      [username]
    );
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Credenziali non valide' });
    }
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Credenziali non valide' });
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '24h' });
    delete user.password_hash;
    res.json({ success: true, token, user });
  } catch (err) {
    console.error('Errore login:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { verifyToken, login };