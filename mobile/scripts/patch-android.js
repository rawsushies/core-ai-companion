'use strict';
// After `cap add/sync android`: camera permission for QR pairing. Cleartext
// HTTP (for the PC on your Wi-Fi) comes from capacitor.config.json.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(file)) { console.log('no android project yet'); process.exit(0); }
let xml = fs.readFileSync(file, 'utf8');
let changed = false;
if (!xml.includes('android.permission.CAMERA')) {
  xml = xml.replace('<application', '<uses-permission android:name="android.permission.CAMERA" />\n    <application');
  changed = true;
}
// The PC companion is plain HTTP on your own network (messages are sealed end to end).
if (!xml.includes('usesCleartextTraffic')) {
  xml = xml.replace('<application', '<application android:usesCleartextTraffic="true"');
  changed = true;
}
if (changed) { fs.writeFileSync(file, xml); console.log('patched AndroidManifest.xml'); }
