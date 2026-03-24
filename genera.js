const bcrypt = require('bcryptjs');
const password = 'fanculo';
const salt = bcrypt.genSaltSync(10);
const hash = bcrypt.hashSync(password + salt, 10);
console.log('salt:', salt);
console.log('hash:', hash);