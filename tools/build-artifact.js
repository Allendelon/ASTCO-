// Builds dist/midad-executive-suite.html: a single self-contained page in the claude.ai
// Artifact format (no doctype/html/head/body; the host adds its own skeleton).
// CSS and app scripts are inlined; Chart.js stays on jsDelivr (on the host's CDN allowlist).
// Usage: node tools/build-artifact.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');

const pick = (re, label) => { const m = html.match(re); if (!m) throw new Error('Missing ' + label); return m[1]; };
const head = pick(/<head>([\s\S]*?)<\/head>/, '<head>');
const body = pick(/<body>([\s\S]*?)<\/body>/, '<body>');
const title = pick(/<title>([\s\S]*?)<\/title>/, '<title>');

const keepHead = [...head.matchAll(/<link [^>]*fonts\.(?:googleapis|gstatic)[^>]*>|<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/g)].map(m => m[0]);
const themeScript = pick(/(<script>\s*\/\/ Apply the saved theme[\s\S]*?<\/script>)/, 'theme script');
const guard = s => s.replace(/<\/script/gi, '<\\/script');

let out = body.replace(/<script src="(assets\/[^"]+)"><\/script>/g, (_, src) => `<script>\n${guard(read(src))}\n</script>`);
out = [
  `<title>${title}</title>`,
  `<style>\n${read('assets/styles.css')}\n</style>`,
  ...keepHead,
  themeScript,
  '<script>window.MIDAD_HOSTED = true;</script>',
  out.trim()
].join('\n');

if (/<\/?(html|head|body)[\s>]/i.test(out.replace(/<script>[\s\S]*?<\/script>/g, ''))) throw new Error('Wrapper tag left in output');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/midad-executive-suite.html'), out);
console.log(`dist/midad-executive-suite.html  ${(out.length / 1024).toFixed(1)} KB`);
