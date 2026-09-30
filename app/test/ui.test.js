'use strict';
// Behaviour of the shared UI components (public/js/ui) in a real browser.
// Needs Playwright with a Chromium build; skipped when it is not installed,
// e.g. NODE_PATH=$(npm root -g) npm test to use a global install.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* optional */ }
const skip = chromium ? false : 'Playwright is not installed';

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html', '.woff2': 'font/woff2' };
let server;
let browser;
let base;

before(async () => {
    if (skip) return;
    server = http.createServer((req, res) => {
        const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const file = url === '/harness.html' ? path.join(__dirname, 'ui', 'harness.html') : path.join(PUBLIC, path.normalize(url));
        if (!file.startsWith(PUBLIC) && !file.endsWith('harness.html')) { res.writeHead(403).end(); return; }
        fs.readFile(file, (err, body) => {
            if (err) { res.writeHead(404).end(); return; }
            res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    const executablePath = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
    browser = await chromium.launch(executablePath ? { executablePath } : {}).catch(() => chromium.launch());
});

after(async () => {
    await browser?.close();
    server?.close();
});

async function page() {
    const p = await browser.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${base}/harness.html`);
    await p.waitForSelector('body[data-ready="1"]');
    p.errors = errors;
    return p;
}

const ROWS = [{ id: 'a', n: 'KAFD-AST-01', title: 'One' }, { id: 'b', n: 'KAFD-AST-02', title: 'Two' }];

test('dataTable: rows open through a real link; controls in a row do not', { skip }, async () => {
    const p = await page();
    await p.evaluate((rows) => {
        const { dataTable, h } = window.T;
        window.clicked = 0;
        const table = dataTable({
            caption: 'Documents', rows, rowHref: (r) => `#doc/${r.id}`,
            columns: [
                { id: 'n', header: 'Number', primary: true, cell: (r) => r.n },
                { id: 't', header: 'Title', cell: (r) => r.title },
                { id: 'x', header: 'Action', cell: () => h('button', { onclick: () => { window.clicked += 1; } }, 'Act') },
            ],
        });
        document.getElementById('stage').append(table.el);
    }, ROWS);

    assert.equal(await p.getAttribute('.table-wrap', 'role'), 'region');
    assert.equal(await p.getAttribute('.table-wrap', 'aria-label'), 'Documents');
    assert.equal(await p.textContent('caption'), 'Documents');
    const link = p.locator('tbody tr:first-child th[scope=row] a.row-link');
    assert.equal(await link.getAttribute('href'), '#doc/a');

    await p.click('tbody tr:nth-child(2) td:nth-child(2)');       // anywhere on the row
    assert.equal(await p.evaluate(() => location.hash), '#doc/b');

    await p.evaluate(() => { location.hash = ''; });
    await p.click('tbody tr:first-child button');                   // a control in the row
    assert.equal(await p.evaluate(() => [location.hash, window.clicked].join()), ',1');

    await p.focus('tbody tr:first-child a.row-link');               // keyboard
    await p.keyboard.press('Enter');
    assert.equal(await p.evaluate(() => location.hash), '#doc/a');

    // Selecting text to copy a number must not navigate away.
    await p.evaluate(() => {
        location.hash = '';
        const td = document.querySelector('tbody tr:nth-child(2) td');
        getSelection().selectAllChildren(td);
        td.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(await p.evaluate(() => location.hash), '');
    assert.deepEqual(p.errors, []);
    await p.close();
});

test('dataTable: needs a caption; a table that scrolls sideways is focusable, one that does not is not', { skip }, async () => {
    const p = await page();
    const threw = await p.evaluate(() => { try { window.T.dataTable({ columns: [] }); return false; } catch { return true; } });
    assert.ok(threw);
    const tabIndex = await p.evaluate(async () => {
        const { dataTable } = window.T;
        const cols = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, header: `Column ${i}`, cell: () => 'wide content here' }));
        const wide = dataTable({ caption: 'Wide', columns: cols, rows: [{}] });
        const narrow = dataTable({ caption: 'Narrow', columns: cols.slice(0, 1), rows: [{}] });
        const stage = document.getElementById('stage');
        stage.style.width = '360px';
        stage.append(wide.el, narrow.el);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return [wide.el.getAttribute('tabindex'), narrow.el.getAttribute('tabindex')];
    });
    assert.deepEqual(tabIndex, ['0', null]);
    await p.close();
});

test('asyncRegion: no skeleton flash on a fast load; skeleton and aria-busy on a slow one', { skip }, async () => {
    const p = await page();
    const result = await p.evaluate(async () => {
        const { asyncRegion, h } = window.T;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const seen = (region) => {
            const log = { skeleton: false, busy: false };
            new MutationObserver(() => {
                if (region.el.querySelector('.skeleton')) log.skeleton = true;
                if (region.el.getAttribute('aria-busy') === 'true') log.busy = true;
            }).observe(region.el, { childList: true, subtree: true, attributes: true });
            return log;
        };
        const fast = asyncRegion({ load: async () => { await wait(20); return [1]; }, render: () => h('p', null, 'fast') });
        const slow = asyncRegion({ load: async () => { await wait(400); return [1]; }, render: () => h('p', null, 'slow') });
        document.getElementById('stage').append(fast.el, slow.el);
        const logFast = seen(fast);
        const logSlow = seen(slow);
        await Promise.all([fast.reload(), slow.reload()]);
        return { logFast, logSlow, text: fast.el.textContent + slow.el.textContent, busy: slow.el.getAttribute('aria-busy') };
    });
    assert.equal(result.logFast.skeleton, false);
    assert.equal(result.logSlow.skeleton, true);
    assert.equal(result.logSlow.busy, true);
    assert.equal(result.text, 'fastslow');
    assert.equal(result.busy, 'false');
    await p.close();
});

test('asyncRegion: a late response never overwrites a newer one, and the old request is aborted', { skip }, async () => {
    const p = await page();
    const result = await p.evaluate(async () => {
        const { asyncRegion, h } = window.T;
        const aborted = [];
        let call = 0;
        const region = asyncRegion({
            load: (signal) => {
                const mine = ++call;
                signal.addEventListener('abort', () => aborted.push(mine));
                // Ignores the signal on purpose: a server that answers anyway.
                return new Promise((r) => setTimeout(() => r([`answer ${mine}`]), mine === 1 ? 300 : 20));
            },
            render: (rows) => h('p', null, rows[0]),
        });
        document.getElementById('stage').append(region.el);
        const first = region.reload();
        const second = region.reload();
        await Promise.all([first, second]);
        await new Promise((r) => setTimeout(r, 350));
        return { text: region.el.textContent, aborted };
    });
    assert.equal(result.text, 'answer 2');
    assert.deepEqual(result.aborted, [1]);
    await p.close();
});

test('asyncRegion: failure shows the error with Retry; empty data shows the empty state', { skip }, async () => {
    const p = await page();
    await p.evaluate(() => {
        const { asyncRegion, emptyState, h } = window.T;
        let attempts = 0;
        window.region = asyncRegion({
            load: async () => { attempts += 1; if (attempts === 1) throw new Error('Server unavailable'); return attempts === 2 ? [] : ['x']; },
            render: () => h('p', null, 'content'),
            empty: () => emptyState({ title: 'Nothing here yet' }),
        });
        document.getElementById('stage').append(window.region.el);
        return window.region.reload();
    });
    assert.equal(await p.textContent('.state-error[role=alert] p'), 'Server unavailable');
    await p.click('.state-error button');
    await p.waitForSelector('.empty');
    assert.equal(await p.textContent('.empty .empty-title'), 'Nothing here yet');
    await p.evaluate(() => window.region.reload());
    assert.equal(await p.textContent('.async-region'), 'content');
    await p.close();
});

test('actionButton: one action per click burst, focus kept, failure reported as an alert', { skip }, async () => {
    const p = await page();
    await p.evaluate(() => {
        const { actionButton } = window.T;
        window.calls = 0;
        window.fail = false;
        const btn = actionButton({
            label: 'Issue', variant: 'primary',
            onClick: () => new Promise((resolve, reject) => {
                window.calls += 1;
                setTimeout(() => (window.fail ? reject(new Error('Not allowed')) : resolve()), 200);
            }),
        });
        document.getElementById('stage').append(btn);
    });
    await p.focus('#stage button');
    await p.keyboard.press('Enter');
    assert.equal(await p.getAttribute('#stage button', 'aria-disabled'), 'true');
    await p.keyboard.press('Enter');
    await p.click('#stage button', { force: true });
    await p.waitForFunction(() => !document.querySelector('#stage button').hasAttribute('aria-disabled'));
    assert.equal(await p.evaluate(() => window.calls), 1);
    assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Issue');

    await p.evaluate(() => { window.fail = true; });
    await p.click('#stage button');
    await p.waitForSelector('#alert .alert-toast');
    assert.match(await p.textContent('#alert'), /Not allowed/);
    await p.keyboard.press('Escape');
    assert.equal(await p.evaluate(() => document.getElementById('alert').childElementCount), 0);
    await p.close();
});

test('confirmDialog: Cancel, Escape and confirm; danger starts on Cancel; focus returns', { skip }, async () => {
    const p = await page();
    await p.evaluate(() => {
        const { actionButton } = window.T;
        window.calls = 0;
        document.getElementById('stage').append(actionButton({
            label: 'Delete', variant: 'danger', onClick: () => { window.calls += 1; },
            confirm: { title: 'Delete P01.1?', body: 'Work in progress can be removed.', confirmLabel: 'Delete', danger: true },
        }));
    });
    await p.click('#stage button');
    await p.waitForSelector('dialog[open][role=alertdialog]');
    assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Cancel');
    const labelled = await p.evaluate(() => {
        const d = document.querySelector('dialog[open]');
        return [document.getElementById(d.getAttribute('aria-labelledby')).textContent, document.getElementById(d.getAttribute('aria-describedby')).textContent];
    });
    assert.deepEqual(labelled, ['Delete P01.1?', 'Work in progress can be removed.']);

    await p.keyboard.press('Enter');                                 // reflexive Enter hits Cancel
    await p.waitForSelector('dialog', { state: 'detached' });
    await p.click('#stage button');
    await p.keyboard.press('Escape');
    await p.waitForSelector('dialog', { state: 'detached' });
    assert.equal(await p.evaluate(() => window.calls), 0);
    assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Delete');

    await p.click('#stage button');
    await p.click('dialog[open] .dlg-foot button.danger');
    await p.waitForFunction(() => window.calls === 1);
    await p.close();
});

test('segmented: a labelled group of toggle buttons; choosing the current one does nothing', { skip }, async () => {
    const p = await page();
    await p.evaluate(() => {
        const { segmented } = window.T;
        window.changes = [];
        const s = segmented({ label: 'Transmittals', options: [['inbox', 'Inbox'], ['sent', 'Sent']], value: 'inbox', onChange: (v) => window.changes.push(v) });
        document.getElementById('stage').append(s.el);
    });
    assert.equal(await p.getAttribute('.segmented', 'role'), 'group');
    assert.equal(await p.getAttribute('.segmented', 'aria-label'), 'Transmittals');
    await p.click('.segmented button:first-child');
    await p.click('.segmented button:nth-child(2)');
    assert.deepEqual(await p.evaluate(() => window.changes), ['sent']);
    assert.deepEqual(await p.$$eval('.segmented button', (bs) => bs.map((b) => b.getAttribute('aria-pressed'))), ['false', 'true']);
    await p.close();
});
