import fs from 'node:fs';
import path from 'node:path';

// Scan web/src/i18n/index.tsx for defined keys
const i18nContent = fs.readFileSync('web/src/i18n/index.tsx', 'utf-8');
const dictRegex = /'([a-zA-Z0-9_.]+)':\s*\[/g;
const definedKeys = new Set();
let match;
while ((match = dictRegex.exec(i18nContent)) !== null) {
  definedKeys.add(match[1]);
}

console.log('Total defined keys in DICT:', definedKeys.size);

// Scan web/src for t('...') calls
function scanDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      scanDir(fullPath);
    } else if (file.endsWith('.tsx') || file.endsWith('.ts')) {
      if (file.includes('.test.') || file === 'index.tsx' && dir.endsWith('i18n')) continue;
      const content = fs.readFileSync(fullPath, 'utf-8');
      const tCallRegex = /\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g;
      let m;
      while ((m = tCallRegex.exec(content)) !== null) {
        const key = m[1];
        if (!definedKeys.has(key)) {
          console.log(`MISSING KEY: "${key}" in ${fullPath}`);
        }
      }
    }
  }
}

scanDir('web/src');
