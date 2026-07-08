#!/usr/bin/env node
const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
    console.error('Usage: node scripts/hash-password.js "<password>"');
    process.exit(1);
}
if (password.length < 12) {
    console.warn('⚠️  That password is shorter than 12 characters — consider something longer.');
}

const hash = bcrypt.hashSync(password, 12);
console.log('\nAdd this to your .env file:\n');
console.log(hash);
console.log('');