# UI components

The browser UI is plain ES modules served as-is: no framework, no build step,
no runtime dependencies. Shared components live in `app/public/js/ui/`, with
behaviour tests in `app/test/ui.test.js`.

## Why no framework (yet)

| | Plain modules (chosen) | React/Vue/Svelte |
|---|---|---|
| Build pipeline | None: the files served are the files in git | Bundler, transpiler, lockfile churn, source maps |
| CSP | `script-src 'self'` works unchanged | Works, but tooling pushes toward inline/eval variants |
| Payload | Whole UI is a few tens of KB | Runtime plus app code |
| Fits today's views | Each view fetches, renders, and re-renders a region | Built for fine-grained client state the app does not have yet |
| Hiring and onboarding | Anyone who knows the DOM | Larger pool knows React |

**Revisit when** a screen needs heavy client-side state: the BIM viewer (ADR-007), an
offline field app, or live collaborative markup. At that point, adopt one framework
for new screens, keep these components' behaviour contracts, and port them.

## Architecture

```
public/js/
  lib.js            h(), render(), api(), t()/tn(), formatting, toast(), dialog()
  ui/table.js       dataTable
  ui/async.js       asyncRegion, emptyState, errorState, skeleton
  ui/controls.js    actionButton, segmented
  ui/dialogs.js     confirmDialog
  views/*.js        pages; compose the above, own no generic behaviour
```

Conventions:

- **A stateless component returns a `Node`.** Examples: `emptyState`, `skeleton`.
- **A stateful component returns a controller `{ el, ...methods }`.** Examples: `dataTable`, `asyncRegion`, `segmented`. Put `el` in the page and call the methods; never reach into its DOM.
- **All text is passed in already translated.** Components only call `t()` for their own chrome (Retry, Cancel, Dismiss), so they work in both Arabic and English and in right-to-left layout.
- **Only the data is dynamic, never markup.** Everything goes through `h()` as text nodes; no component accepts HTML strings.

## API

### `dataTable({ caption, columns, rows?, rowHref?, rowClass? })` → `{ el, setRows(rows), appendRows(rows) }`

| Prop | Type | Notes |
|---|---|---|
| `caption` | string, **required** | Accessible name of the table and its scroll region. It throws without one. |
| `columns` | `Column[]` | See below. |
| `rows` | array | Initial rows. |
| `rowHref` | `(row) => string` | Makes each row open that URL. |
| `rowClass` | `(row) => string` | Extra class per row, e.g. `is-overdue`. |

`Column`: `{ id, header, cell(row) → Node | string | array, primary?, numeric?, priority?: 'low', className? }`

- `primary`: this cell is the row header (`<th scope="row">`). With `rowHref`, it holds the row's link.
- `numeric`: the column never wraps.
- `priority: 'low'`: the column is hidden below 720 px wide.

Behaviour:

- **Rows that open something are real links.** Keyboard, screen readers, middle-click and "open in new tab" all work.
- **A click elsewhere on the row follows the link,** except on a control inside the row or while text is selected. Ctrl-, ⌘- or Shift-click opens a new tab.
- **The scroll region can be focused only when it actually scrolls sideways.** Keyboard users can then scroll it (WCAG 2.1.1).

### `asyncRegion({ load, render, empty?, isEmpty?, placeholder?, delayMs? })` → `{ el, reload(), data }`

| Prop | Type | Notes |
|---|---|---|
| `load` | `(signal) => Promise<data>` | Pass `signal` to `api()` so superseded requests are cancelled. |
| `render` | `(data) => Node` | Content for non-empty data. |
| `empty` | `(data) => Node` | Usually `emptyState(...)`. |
| `isEmpty` | `(data) => boolean` | Default: empty array. |
| `placeholder` | `() => Node` | Default: `skeleton()`. |
| `delayMs` | number | Default 150. Loads faster than this show no skeleton. |

Guarantees (each has a test):

- **First load:** the skeleton appears only after `delayMs`, so fast responses do not flash.
- **Reload:** the existing content stays, dimmed and `aria-busy`, so search-as-you-type does not jump.
- **Overlapping reloads:** the older request is aborted, and a late answer can never replace a newer one.
- **Failure:** an `role="alert"` error with a Retry button replaces the content.

### `actionButton({ label, onClick, onDone?, confirm?, variant?, ...attrs })` → `HTMLButtonElement`

- **One action per burst of clicks.** While `onClick` runs, the button is `aria-disabled` and `aria-busy`, and further clicks are ignored. It deliberately uses `aria-disabled` rather than `disabled`, because disabling a focused button drops keyboard focus to the page.
- **`onDone(result)` runs only on success;** failures go to `toast(message, 'error')`.
- **`confirm`** takes the options for `confirmDialog`, and the action runs only if the user confirms.

### `confirmDialog({ title, body?, confirmLabel, cancelLabel?, danger? })` → `Promise<boolean>`

- **Semantics:** `role="alertdialog"`, labelled by the title and described by the body.
- **Dangerous actions start on Cancel,** so a reflexive Enter does nothing.
- **Escape means no,** and focus returns to the control that opened the dialog.
- **It replaces `window.confirm()`,** whose buttons are in the browser's language, not the page's.

### `segmented({ label, options: [[value, text]], value, onChange })` → `{ el, value }`

A labelled `role="group"` of `aria-pressed` toggle buttons, used for filters such as Inbox / Sent / All. It is deliberately not ARIA tabs: tabs promise a tab panel and arrow-key navigation, and a filter needs neither.

### `emptyState({ title?, body?, action? })`, `errorState(message, retry?)`, `skeleton(lines?)` → `Node`

### `toast(message, kind?)` (lib.js)

- **Confirmations** are announced politely and fade after 4 s.
- **Errors** (`kind = 'error'`) are announced assertively and stay until dismissed (× or Escape). A message that disappears while it is being read fails WCAG 2.2.1.

## Usage

A filtered list with loading, empty and error states:

```js
import { dataTable } from '../ui/table.js';
import { asyncRegion, emptyState } from '../ui/async.js';

const table = dataTable({
    caption: t('docs.title'),
    rowHref: (d) => `#/p/${pid}/documents/${d.id}`,
    columns: [
        { id: 'number', header: t('docs.col.number'), primary: true, cell: (d) => docNo(d.document_number) },
        { id: 'title', header: t('docs.col.title'), cell: (d) => d.title },
        { id: 'updated', header: t('docs.col.updated'), numeric: true, priority: 'low', cell: (d) => fmtDate(d.revised_at) },
    ],
});
const list = asyncRegion({
    load: (signal) => api('GET', `/projects/${pid}/documents?q=${encodeURIComponent(search.value)}`, undefined, { signal }),
    render: (rows) => table.setRows(rows).el,
    empty: () => emptyState({ title: t('docs.empty') }),
});
let timer;
search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(list.reload, 200); });
await list.reload();
page.append(list.el);
```

An irreversible server action:

```js
actionButton({
    label: t('trv.close'),
    onClick: () => api('POST', `/transmittals/${id}/close`),
    onDone: ctx.refresh,
    confirm: { title: t('trv.close'), body: t('trv.confirm_close'), confirmLabel: t('trv.close') },
});
```

## Rules for new UI

1. **A list of records is a `dataTable`.** Don't hand-build a `<table>` with clickable `<tr>`s.
2. **Server data in a region is an `asyncRegion`.** Give it an empty state that says what to do next, not just "No data".
3. **A button that calls the server is an `actionButton`.** Irreversible actions pass `confirm`, and destructive ones set `danger: true`.
4. **No `window.confirm`, `alert` or `prompt`.**
5. **Every string goes through `t()`/`tn()`, and codes go through `ltr()`.** Codes are document numbers, revisions, hashes and ids. Names placed inline next to other text go through `bidi()`, and user-written paragraphs get `dir="auto"`. See docs/I18N.md.
6. **Use logical CSS properties** (`margin-inline-start`, `border-inline-end`, `text-align: start`), so right-to-left layout needs no overrides.
7. **Don't re-add ARIA a native element already has.** Don't use a role whose keyboard contract you don't implement.
8. **Behaviour changes to a component need a test in `test/ui.test.js`.** Check that the test fails without the change.

## Testing

- `npm test` runs the component tests in Chromium when Playwright is installed. Otherwise they are skipped (e.g. `NODE_PATH=$(npm root -g) npm test` uses a global install).
- The harness is `test/ui/harness.html`. It loads the real modules and the English catalog.
- Tests assert behaviour and accessibility contracts: roles, names, focus, keyboard and race conditions. They never assert pixels.

## Known gaps

- **On phones, wide tables scroll sideways** after the low-priority columns hide. A stacked card layout per row would read better. `dataTable` can gain one behind the same column API.
- **Forms still use `dialog()`/`field()` in lib.js.** A form component with inline per-field errors from the server's `field` parameter is the next step.
- **No virtualisation.** Lists are capped server-side (1,000 documents, 200 audit entries a page). Past that, paginate on the server rather than virtualise in the browser.
- **No automated axe-style audit.** Adding one means a new dependency, which should be a deliberate decision.
