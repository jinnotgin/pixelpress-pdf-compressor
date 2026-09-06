// Run the PDF image/finalisation regressions in the app's WebAssembly runtime.
// PYODIDE_MODULE may point to an external installation to keep it out of the app bundle.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const root = fileURLToPath(new URL('../', import.meta.url));
const moduleName = process.env.PYODIDE_MODULE || 'pyodide';
const moduleUrl = path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName;
const { loadPyodide } = await import(moduleUrl);
const py = await loadPyodide({ packageCacheDir: process.env.PYODIDE_PACKAGE_CACHE });
const config = await readFile(path.join(root, 'src/features/compression/config.ts'), 'utf8');
const expectedVersion = config.match(/pyodide@(\d+\.\d+\.\d+)/)?.[1];
if (py.version !== expectedVersion) {
  throw new Error(`Expected Pyodide ${expectedVersion}, got ${py.version}`);
}
await py.loadPackage(['pymupdf', 'pillow']);
for (const file of [
  'src/features/compression/workers/pixelpress.py',
  'tests/test_image_rewrite.py',
  'tests/test_finalize_stages.py',
]) {
  const destination = `/workspace/${file}`;
  py.FS.mkdirTree(path.posix.dirname(destination));
  py.FS.writeFile(destination, await readFile(path.join(root, file), 'utf8'));
}
const success = py.runPython(`
import unittest, sys, pymupdf
sys.path.insert(0, '/workspace/tests')
print('PyMuPDF / MuPDF:', pymupdf.version)
suite = unittest.TestLoader().loadTestsFromNames(['test_image_rewrite', 'test_finalize_stages'])
unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
`);
if (!success) process.exitCode = 1;
