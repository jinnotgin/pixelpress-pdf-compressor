# PixelPress

A privacy-focused PDF compressor that processes your documents locally in your
browser. Your PDFs stay on your device and are never uploaded to cloud services.

PixelPress automatically preserves efficient document pages and flattens clearly
vector-heavy exports. A dedicated Figma preset keeps the original aggressive
flattening workflow for screens and diagrams.

Pyodide + PyMuPDF process PDFs in a browser Web Worker. Optional multilingual OCR
uses Tesseract locally and is off by default; enable it to add searchable text to
pages without usable selectable text. Runtimes and OCR models are downloaded on
first use, but document processing stays on your device.

A Vite + React + TypeScript app, organised with a
[bulletproof-react](https://github.com/alan2207/bulletproof-react) style
architecture.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR. |
| `npm run build` | Type-check and build multiple assets into `dist/`. |
| `npm run build:single` | Type-check and bundle all local JS, CSS, and worker code into `dist-single/index.html`. |
| `npm run preview` / `npm run preview:single` | Serve the corresponding build output. |
| `npm run typecheck` | `tsc -b` with no emit. |
| `npm run lint` | ESLint (flat config, with import-boundary rules). |
| `npm run test` | Vitest unit tests. |
| `npm run format` | Prettier. |

The Pyodide and Tesseract runtimes are fetched from a pinned CDN URL on first use
(too large to bundle) and then cached by the browser.

## Deployment

Pushing to `main` builds the app and publishes `dist/` to GitHub Pages via
[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml). Enable
it once in the repo settings: **Pages > Build and deployment > Source: GitHub
Actions**.

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
        ├── index.ts         Public surface; the only file others import from
        ├── config.ts        Feature constants (limits, CDN URLs, storage keys)
        ├── types.ts         Domain types + the worker message protocol
        ├── components/       SettingsPanel, DropZone, JobRow, RangeControl, ...
        ├── hooks/            usePersistentSettings, useStorageEstimate,
        │                     useCompressionQueue (worker + queue orchestration)
        ├── services/         Worker client, OPFS read + history restore
        ├── utils/            resolveSettings, formatTextSummary, job intake + tests
        └── workers/          pixelpress.worker.ts + pixelpress.py (imported ?raw)
```

### The worker

`workers/pixelpress.worker.ts` runs the whole pipeline off the main thread. The
Python lives in `workers/pixelpress.py` and is pulled in as a raw string
(`import PYTHON_SOURCE from './pixelpress.py?raw'`), so it stays readable and
lints as real Python.

### Inspecting strategy reports

Open the browser developer tools, select **Console**, and filter for
`PixelPress strategy`. Reports are labeled **Hybrid**, **Preserve**, or **Flatten**
to match the requested strategy, including when using the Custom preset.
Each report includes the document decision, detected PDF features, and a copyable
object. When pages are analyzed, a table shows each page's compression
strategy, reason, text counts, largest-image coverage, and protection status.
`ocrPlanned` indicates whether OCR is planned to add searchable text, independently
of the compression strategy. It does not confirm OCR success.

Only Auto reports include decision thresholds, per-page threshold checks, and
content-stream sizes; manual strategies do not measure content-stream complexity.
Documents kept unchanged before page analysis have no per-page table. Reports
never include filenames, extracted text, page images, or PDF bytes.

### State ownership

- `usePersistentSettings`: settings form state, mirrored to `localStorage` and
  re-validated on load.
- `useCompressionQueue`: the worker lifecycle, the job queue, OPFS history
  restore, storage accounting, and the object URLs handed to the download button.
- Components own only view state (settings drawer open, drag-hover).

## Notes / limitations

- OPFS (`navigator.storage.getDirectory`) is used for streaming large inputs and
  persisting results for 30 days. Where it is unavailable the worker falls back
  to in-memory transfer and the UI shows `Ready (M)`.
- OCR supports English, Simplified Chinese, Traditional Chinese, Malay, and Tamil. It runs solely on pages without usable selectable text.
- OCR adds an invisible searchable-text layer while preserving the page image.
  It runs at 200 DPI and may tile large pages; complex layouts can affect reading
  order and accuracy.
- Embedded images are processed once per shared image. Complete candidates are
  constructed and saved by PyMuPDF/Pillow, imported, and copied using the same
  documented `xref_copy` operation used by `Page.replace_image`. No `/Image`
  dictionaries are hand-edited, and the native whole-document rewriter is avoided.
  JPEG and lossless candidates compete on saved image storage; lossless wins
  when within 10% of JPEG. Transparent photographs can use JPEG colour with a
  separate lossless soft mask; resizing samples premultiplied colour and alpha
  together to avoid fringes. Black/white content keeps its original resolution
  and compares packed Flate with CCITT Group 4 (when libtiff is available).
  Low-DPI images can be recompressed at their existing dimensions; the detail
  threshold controls resizing only.
  Additional codec candidates are limited to 24 megapixels to bound transient
  memory. Larger opaque images retain JPEG recompression; some larger masked
  images are preserved. Special masks, unsupported encodings and special colour
  spaces are preserved. Candidates must reduce saved image storage, accounting
  conservatively for shared masks. This is not full parity with MuPDF's rewriter.
- Run PDF-engine regression tests with `python3 -m unittest discover -s tests -v`
  (PyMuPDF >= 1.26.1 and Pillow >= 11; OCR checks also require the `tesseract` CLI).
  The worker loads both PyMuPDF and Pillow from the pinned Pyodide distribution.
  Run `node tests/run_pyodide.mjs` with the matching `pyodide` npm package installed
  to check image/finalisation tests in WebAssembly. `PYODIDE_MODULE` can point to
  an external `pyodide.mjs` installation, and `PYODIDE_PACKAGE_CACHE` selects its
  downloaded wheel cache. The runner verifies the version against app config.
- Signed PDFs are kept byte-for-byte unchanged. When compression does not beat
  the source size, PixelPress returns the original instead.
- Requires a modern browser with module Web Workers and `SharedArrayBuffer`-free
  Pyodide (no COOP/COEP headers needed).
