'use strict';
// Copies the pieces www needs from packages and the brand kit (not committed).
const fs = require('fs');
const path = require('path');
const here = path.join(__dirname, '..');
fs.copyFileSync(require.resolve('tweetnacl/nacl-fast.min.js', { paths: [here, path.join(here, '..')] }), path.join(here, 'www', 'nacl.js'));
fs.copyFileSync(path.join(here, '..', 'assets', 'brand', 'icon-128.png'), path.join(here, 'www', 'icon.png'));
console.log('copied nacl.js and icon.png into www');
