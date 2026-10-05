'use strict';
// Compiles Tailwind and copies third-party browser assets into public/vendor so the
// deployed app does not depend on public CDNs. Run after `npm install`: npm run build:assets
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'public', 'vendor');
const nm = path.join(root, 'node_modules');
fs.rmSync(vendor, { recursive: true, force: true });
fs.mkdirSync(vendor, { recursive: true });

execFileSync(process.execPath, [
  path.join(nm, 'tailwindcss', 'lib', 'cli.js'),
  '-c', path.join(root, 'tailwind.config.js'),
  '-i', path.join(root, 'assets', 'tailwind.input.css'),
  '-o', path.join(vendor, 'tailwind.css'),
  '--minify',
], { stdio: 'inherit' });

fs.copyFileSync(path.join(nm, 'chart.js', 'dist', 'chart.umd.js'), path.join(vendor, 'chart.umd.js'));
for (const weight of ['regular', 'bold', 'fill']) {
  // style.css + WOFF2/WOFF only; every supported browser picks WOFF2, so the SVG/TTF fallbacks are dead weight.
  const src = path.join(nm, '@phosphor-icons', 'web', 'src', weight);
  const dest = path.join(vendor, 'phosphor', weight);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    if (/\.(css|woff2?)$/.test(file)) fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
}
console.log('Assets written to public/vendor');
