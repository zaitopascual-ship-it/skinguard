const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
    console.error('Usage: node scripts/hash-password.js "<password>"');
    process.exit(1);
}
if (password.length < 12) {
    console.warn('WARNING: that password is shorter than 12 characters - consider something longer.');
}

const hash = bcrypt.hashSync(password, 12);
console.log('');
console.log('Add this to your .env file:');
console.log('');
console.log(hash);
console.log('');
