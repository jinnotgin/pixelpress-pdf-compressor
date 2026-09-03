# PixelPress

Browser-only PDF compressor. Every byte is processed **on the user's device** —
Pyodide + PyMuPDF do the PDF work and Tesseract handles optional English OCR, all
inside a Web Worker. Nothing is uploaded.

This is the `pixelpress-browser.html` prototype unpacked into a Vite + React +
TypeScript app, organised with a
[bulletproof-react](https://github.com/alan2207/bulletproof-react) style
architecture. The original single file is kept at
[`reference/pixelpress-browser.html`](reference/pixelpress-browser.html) as a
snapshot, and the `npm run build:single` command reproduces an equivalent
one-file distribution.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR. |
| `npm run build` | Type-check, then a normal multi-asset build into `dist/`. |
| `npm run build:single` | Type-check, then bundle **everything local** (JS, CSS, worker) into one self-contained `dist-single/index.html`. |
| `npm run preview` / `npm run preview:single` | Serve the corresponding build output. |
| `npm run typecheck` | `tsc -b` with no emit. |
| `npm run lint` | ESLint (flat config, with import-boundary rules). |
| `npm run test` | Vitest unit tests. |
| `npm run format` | Prettier. |

> The Pyodide and Tesseract runtimes are always fetched from a pinned CDN URL on
> first use (they are far too large to bundle) and then cached by the browser.
> `build:single` inlines only first-party code, exactly like the original page.

## Architecture

Dependencies flow in one direction only, enforced by
`import/no-restricted-paths` in `eslint.config.js`:

```
shared (components / hooks / utils / config)  <-  features  <-  app
```

- Features may not import from `app`, and may not import each other.
- Shared code may not import from `features` or `app`.

```
src/
├── app/                     Composition root + global providers (error boundary)
├── config/                  Validated runtime env (src/config/env.ts)
├── components/ui/            Design-system primitives (Icon, Notice)
├── utils/                    Framework-agnostic helpers (formatBytes) + tests
├── styles/                   Global stylesheet (design tokens + layout)
└── features/
    └── compression/         The one feature: the compressor
        ├── index.ts         Public surface — the only file others import from
        ├── config.ts        Feature constants (limits, CDN URLs, storage keys)
        ├── types.ts         Domain types + the worker message protocol
        ├── components/       SettingsPanel, DropZone, JobRow, RangeControl, …
        ├── hooks/            usePersistentSettings, useStorageEstimate,
        │                     useCompressionQueue (worker + queue orchestration)
        ├── services/         Worker client, OPFS read + history restore
        ├── utils/            resolveSettings, formatTextSummary, job intake + tests
        └── workers/          pixelpress.worker.ts + pixelpress.py (imported ?raw)
```

### The worker

`workers/pixelpress.worker.ts` is a near line-for-line port of the worker that
was inlined in the prototype. The Python pipeline lives in
`workers/pixelpress.py` and is pulled in as a raw string
(`import PYTHON_SOURCE from './pixelpress.py?raw'`), so it stays readable and
lints as real Python.

### State ownership

- `usePersistentSettings` — settings form state, mirrored to `localStorage` and
  re-validated on load.
- `useCompressionQueue` — the worker lifecycle, the job queue, OPFS history
  restore, storage accounting, and the object URLs handed to the download button.
- Components own only view state (settings drawer open, drag-hover).

## Notes / limitations

- OPFS (`navigator.storage.getDirectory`) is used for streaming large inputs and
  persisting results for 30 days. Where it is unavailable the worker falls back
  to in-memory transfer and the UI shows `Ready (M)`.
- OCR is English-only and runs solely on pages without usable selectable text.
- Requires a modern browser with module Web Workers and `SharedArrayBuffer`-free
  Pyodide (no COOP/COEP headers needed).
