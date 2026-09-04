/// <reference lib="webworker" />
/**
 * PixelPress processing worker.
 *
 * Loads Pyodide + PyMuPDF from the CDN, runs the PDF pipeline defined in
 * `pixelpress.py`, and (when available) streams inputs and results through the
 * Origin Private File System so nothing large sits in memory. Optional multilingual
 * OCR is done with Tesseract, also loaded from the CDN on first use.
 *
 * This module is a direct port of the worker that was inlined in the original
 * single-file `pixelpress-browser.html`.
 */
import {
  OCR_LANGUAGE_LABELS,
  OPFS_CHUNK_SIZE as CHUNK_SIZE,
  PYODIDE_INDEX_URL,
  PYODIDE_MODULE_URL,
  TESSERACT_MODULE_URL as TESSERACT_URL,
} from '../config';
import {
  type PageAnalysis,
  type ResolvedSettings,
  type TextSummary,
  type WorkerInbound,
} from '../types';
import { AUTO_STRATEGY_THRESHOLDS, explainPageStrategy } from '../utils/strategy';
import PYTHON_SOURCE from './pixelpress.py?raw';

declare const self: DedicatedWorkerGlobalScope;

let pyodide: any = null;
let ocrWorker: any = null;
let createOCRWorker: ((...args: any[]) => any) | null = null;
let ocrContext: { jobId: string; page: number; pages: number } | null = null;

function send(type: string, payload: Record<string, unknown> = {}): void {
  self.postMessage({ type, ...payload });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

async function boot(): Promise<void> {
  try {
    send('runtime', { status: 'loading', message: 'Loading Python runtime' });
    const pyodideModule: any = await import(/* @vite-ignore */ PYODIDE_MODULE_URL);
    const loadPyodide = pyodideModule.loadPyodide ?? pyodideModule.default?.loadPyodide;
    pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
    send('runtime', { status: 'loading', message: 'Loading PDF engine' });
    await pyodide.loadPackage(['pymupdf']);
    await pyodide.runPythonAsync(PYTHON_SOURCE);
    const opfs = Boolean(self.isSecureContext && navigator.storage && navigator.storage.getDirectory);
    send('runtime', { status: 'ready', message: opfs ? 'Ready' : 'Ready (M)', opfs });
  } catch (error) {
    send('runtime', { status: 'error', message: safeMessage(error) });
  }
}

function callPython(name: string, ...args: unknown[]): any {
  const callable = pyodide.globals.get(name);
  try {
    return callable(...args);
  } finally {
    callable.destroy();
  }
}

async function directoryForPath(
  path: string,
  create: boolean,
): Promise<{ directory: any; filename: string }> {
  const root: any = await navigator.storage.getDirectory();
  const parts = path.split('/').filter(Boolean);
  const filename = parts.pop() as string;
  let directory = root;
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create });
  }
  return { directory, filename };
}

async function writeBytesToOPFS(path: string, bytes: Uint8Array): Promise<void> {
  const { directory, filename } = await directoryForPath(path, true);
  const fileHandle = await directory.getFileHandle(filename, { create: true });
  const access = await fileHandle.createSyncAccessHandle();
  try {
    await access.truncate(0);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const end = Math.min(offset + CHUNK_SIZE, bytes.byteLength);
      const chunk = bytes.subarray(offset, end);
      await access.write(chunk, { at: offset });
      offset = end;
    }
    await access.flush();
  } finally {
    await access.close();
  }
}

async function stageInput(jobId: string, file: File): Promise<File> {
  const path = `pixelpress/jobs/${jobId}/input.pdf`;
  const { directory, filename } = await directoryForPath(path, true);
  const fileHandle = await directory.getFileHandle(filename, { create: true });
  const access = await fileHandle.createSyncAccessHandle();
  try {
    await access.truncate(0);
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      await access.write(chunk, { at: offset });
      offset = end;
      send('progress', {
        id: jobId,
        progress: Math.max(1, Math.round((offset / Math.max(file.size, 1)) * 8)),
        message: 'Staging file in private browser storage',
      });
    }
    await access.flush();
  } finally {
    await access.close();
  }
  return fileHandle.getFile();
}

async function persistMemFile(
  jobId: string,
  memPath: string,
  outputName: string,
  metadata: Record<string, unknown>,
): Promise<{ size: number; opfsPath: string }> {
  const extension = outputName.split('.').pop();
  const opfsPath = `pixelpress/jobs/${jobId}/output.${extension}`;
  const { directory, filename } = await directoryForPath(opfsPath, true);
  const fileHandle = await directory.getFileHandle(filename, { create: true });
  const access = await fileHandle.createSyncAccessHandle();
  const stream = pyodide.FS.open(memPath, 'r');
  const size: number = pyodide.FS.stat(memPath).size;
  const buffer = new Uint8Array(Math.min(CHUNK_SIZE, Math.max(size, 1)));
  try {
    await access.truncate(0);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(buffer.byteLength, size - offset);
      const read = pyodide.FS.read(stream, buffer, 0, length, offset);
      await access.write(buffer.subarray(0, read), { at: offset });
      offset += read;
      send('progress', {
        id: jobId,
        progress: 97 + Math.round((offset / Math.max(size, 1)) * 2),
        message: 'Saving result locally',
      });
    }
    await access.flush();
  } finally {
    pyodide.FS.close(stream);
    await access.close();
  }
  await writeBytesToOPFS(
    `pixelpress/jobs/${jobId}/metadata.json`,
    new TextEncoder().encode(
      JSON.stringify(
        Object.assign({}, metadata, {
          outputName,
          opfsPath,
          size,
          completedAt: Date.now(),
        }),
      ),
    ),
  );
  return { size, opfsPath };
}

async function deliverPdfResult({
  jobId,
  sourcePath,
  outputName,
  metadata,
  pages,
  textSummary,
  usedOriginal,
  opfsAvailable,
}: {
  jobId: string;
  sourcePath: string;
  outputName: string;
  metadata: Record<string, unknown>;
  pages: number;
  textSummary: TextSummary | null;
  usedOriginal: boolean;
  opfsAvailable: boolean;
}): Promise<void> {
  if (opfsAvailable) {
    try {
      const persisted = await persistMemFile(jobId, sourcePath, outputName, metadata);
      send('done', {
        id: jobId,
        outputName,
        outputSize: persisted.size,
        opfsPath: persisted.opfsPath,
        pages,
        textSummary,
        usedOriginal,
      });
      return;
    } catch (error) {
      send('warning', {
        id: jobId,
        message: `Could not retain the result in OPFS: ${safeMessage(error)}`,
      });
    }
  }

  const bytes: Uint8Array = pyodide.FS.readFile(sourcePath);
  const transferable = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  self.postMessage(
    {
      type: 'done',
      id: jobId,
      outputName,
      outputSize: bytes.byteLength,
      outputBuffer: transferable,
      pages,
      textSummary,
      usedOriginal,
    },
    [transferable],
  );
}

function mountInput(jobId: string, file: File): { mountPath: string; inputPath: string } {
  const mountPath = `/pixelpress-input-${jobId}`;
  pyodide.FS.mkdirTree(mountPath);
  pyodide.FS.mount(pyodide.FS.filesystems.WORKERFS, { files: [file] }, mountPath);
  return { mountPath, inputPath: `${mountPath}/${file.name}` };
}

function unmountInput(mountPath: string): void {
  try {
    pyodide.FS.unmount(mountPath);
  } catch {
    /* already gone */
  }
  try {
    pyodide.FS.rmdir(mountPath);
  } catch {
    /* already gone */
  }
}

async function getOCRWorker(
  jobId: string,
  pages: number,
  language: ResolvedSettings['ocrLanguage'],
): Promise<any> {
  if (ocrWorker) return ocrWorker;
  const languageLabel = OCR_LANGUAGE_LABELS[language];
  send('progress', {
    id: jobId,
    progress: 12,
    message: `Loading the ${languageLabel} text recognition model for the first time`,
  });
  if (!createOCRWorker) {
    const tesseractModule: any = await import(/* @vite-ignore */ TESSERACT_URL);
    const tesseractAPI = tesseractModule.default || tesseractModule;
    createOCRWorker = tesseractAPI.createWorker || tesseractModule.createWorker;
    if (typeof createOCRWorker !== 'function') {
      throw new Error('The text recognition module loaded without a createWorker API.');
    }
  }
  ocrContext = { jobId, page: 0, pages };
  ocrWorker = await createOCRWorker(language, 1, {
    logger(message: any) {
      if (!ocrContext || message.status !== 'recognizing text') return;
      const pageFraction =
        (ocrContext.page + Number(message.progress || 0)) / Math.max(ocrContext.pages, 1);
      send('progress', {
        id: ocrContext.jobId,
        progress: 16 + Math.round(pageFraction * 76),
        message: `Reading text on page ${ocrContext.page + 1} of ${ocrContext.pages}`,
      });
    },
  });
  return ocrWorker;
}

async function terminateOCR(): Promise<void> {
  if (ocrWorker) {
    try {
      await ocrWorker.terminate();
    } catch {
      /* ignore */
    }
    ocrWorker = null;
    ocrContext = null;
  }
}

interface ProcessRequest {
  id: string;
  file: File;
  settings: ResolvedSettings;
}

async function processJob({ id, file, settings }: ProcessRequest): Promise<void> {
  const opfsAvailable = Boolean(
    self.isSecureContext && navigator.storage && navigator.storage.getDirectory,
  );
  let mounted: { mountPath: string; inputPath: string } | null = null;
  let outputPath = '';
  let staged = false;
  try {
    send('progress', { id, progress: 1, message: 'Preparing local workspace' });
    let readableFile = file;
    if (opfsAvailable) {
      try {
        readableFile = await stageInput(id, file);
        staged = true;
      } catch (error) {
        send('warning', {
          id,
          message: `Private storage was unavailable, continuing in memory: ${safeMessage(error)}`,
        });
        readableFile = file;
      }
    }

    mounted = mountInput(id, readableFile);
    const opened = JSON.parse(
      callPython('pp_open', id, mounted.inputPath, JSON.stringify(settings)),
    );
    const pages: number = opened.pages;
    if (!pages) throw new Error('This PDF has no pages.');

    outputPath = `/tmp/pixelpress-${id}.pdf`;
    const baseName = file.name.replace(/\.pdf$/i, '') || 'document';
    const outputName = `${baseName}-pixelpress.pdf`;
    const textSummary = { nativePages: 0, rebuiltPages: 0, ocrPages: 0, imageOnlyPages: 0 };
    const documentFeatures = {
      signed: Boolean(opened.forceOriginal),
      forms: Boolean(opened.hasForms),
      annotations: Boolean(opened.hasAnnotations),
      links: Boolean(opened.hasLinks),
      tagged: Boolean(opened.tagged),
    };
    const deliverOriginal = async (message: string): Promise<void> => {
      send('warning', { id, message });
      const metadata = {
        originalName: file.name,
        originalSize: file.size,
        settings,
        textSummary: null,
        usedOriginal: true,
      };
      await deliverPdfResult({
        jobId: id,
        sourcePath: mounted!.inputPath,
        outputName,
        metadata,
        pages,
        textSummary: null,
        usedOriginal: true,
        opfsAvailable,
      });
    };
    const preserveOriginal =
      opened.forceOriginal ||
      (settings.strategy !== 'flatten' &&
        (opened.preserveStructure || (settings.strategy === 'optimize' && opened.tagged)));
    if (preserveOriginal) {
      const protectedFeatures = [
        opened.forceOriginal && 'a protected signature',
        opened.hasForms && 'interactive forms',
        opened.hasAnnotations && 'annotations',
        settings.strategy === 'optimize' && opened.tagged && 'tagged accessibility structure',
      ].filter((feature): feature is string => Boolean(feature));
      const documentReason = `Kept the original because it contains ${protectedFeatures.join(', ')}.`;
      send('strategy-debug', {
        id,
        report: {
          requestedStrategy: settings.strategy,
          documentAction: 'keep-original',
          documentReason,
          documentFeatures,
          thresholds: AUTO_STRATEGY_THRESHOLDS,
          pages: [],
        },
      });
      await deliverOriginal(`${documentReason} Choose Flatten explicitly to remove interactivity.`);
      return;
    }

    const analyses: PageAnalysis[] = [];
    for (let page = 0; page < pages; page += 1) {
      send('progress', {
        id,
        progress: 10 + Math.round(((page + 1) / pages) * 12),
        message: `Checking searchable text on page ${page + 1} of ${pages}`,
      });
      const analysis = JSON.parse(
        callPython('pp_analyze_page', id, page, settings.strategy === 'auto'),
      ) as PageAnalysis;
      analyses.push(analysis);
    }

    const pageDecisions = analyses.map((analysis) =>
      explainPageStrategy(settings.strategy, analysis),
    );
    const pageStrategies = pageDecisions.map((decision) => decision.strategy);
    const needsOcr = analyses.map((analysis) => settings.recognizeText && !analysis.usable);
    const preserveTaggedAuto =
      settings.strategy === 'auto' &&
      opened.tagged &&
      !pageStrategies.some((strategy) => strategy === 'flatten');
    const documentReason = preserveTaggedAuto
      ? 'Auto found tagged accessibility structure and no page strongly qualified for flattening.'
      : settings.strategy === 'auto'
        ? 'Auto evaluated every page against the vector-heavy thresholds.'
        : `Every page follows the explicitly selected ${settings.strategy} strategy unless OCR is needed.`;
    send('strategy-debug', {
      id,
      report: {
        requestedStrategy: settings.strategy,
        documentAction: preserveTaggedAuto ? 'keep-original' : 'analyze-pages',
        documentReason,
        documentFeatures,
        thresholds: AUTO_STRATEGY_THRESHOLDS,
        pages: pageDecisions.map((decision, page) => ({
          page: page + 1,
          decision: decision.strategy,
          finalAction: needsOcr[page] ? 'ocr' : decision.strategy,
          reason: needsOcr[page]
            ? `OCR takes precedence because page ${page + 1} has no usable selectable text. ${decision.reason}`
            : decision.reason,
          usableText: analyses[page].usable,
          characters: analyses[page].characters,
          words: analyses[page].words,
          largestImageCoveragePercent: round1(analyses[page].imageCoverage * 100),
          contentStreamBytes: analyses[page].contentBytes,
          protected: analyses[page].protected,
          checks: decision.checks,
        })),
      },
    });
    if (preserveTaggedAuto) {
      await deliverOriginal(
        'This tagged PDF did not contain a page that strongly qualified for flattening, so PixelPress kept its accessibility structure unchanged.',
      );
      return;
    }
    if (opened.preserveStructure && settings.strategy === 'flatten') {
      send('warning', {
        id,
        message: 'Flattening preserves appearance but makes forms and annotations non-interactive.',
      });
    }
    const nativePages = pageStrategies
      .map((strategy, page) => ({ strategy, page }))
      .filter(({ strategy, page }) => strategy === 'optimize' && !needsOcr[page])
      .map(({ page }) => page);
    const lastOriginalPage = nativePages.at(-1) ?? -1;

    for (let page = 0; page < pages; page += 1) {
      const analysis = analyses[page];
      if (needsOcr[page]) {
        const languageLabel = OCR_LANGUAGE_LABELS[settings.ocrLanguage];
        const recognizer = await getOCRWorker(id, pages, settings.ocrLanguage);
        ocrContext = { jobId: id, page, pages };
        send('progress', {
          id,
          progress: 14 + Math.round((page / pages) * 76),
          message: `No selectable text on page ${page + 1}; reading it in ${languageLabel}`,
        });
        const imagePath = `/tmp/pixelpress-${id}-ocr-page`;
        const render = JSON.parse(callPython('pp_render_ocr_page', id, page, imagePath));
        const imageBytes = pyodide.FS.readFile(imagePath);
        await recognizer.setParameters({ user_defined_dpi: String(render.effectiveDpi) });
        const result = await recognizer.recognize(
          imageBytes,
          { pdfTitle: file.name },
          { pdf: true, text: true },
        );
        if (!result.data.pdf) {
          throw new Error('Text recognition did not produce a searchable PDF page.');
        }
        const pagePdfPath = `/tmp/pixelpress-${id}-ocr-page.pdf`;
        pyodide.FS.writeFile(pagePdfPath, new Uint8Array(result.data.pdf));
        callPython('pp_append_ocr_pdf', id, pagePdfPath, page);
        textSummary.ocrPages += 1;
        try {
          pyodide.FS.unlink(imagePath);
        } catch {
          /* ignore */
        }
        try {
          pyodide.FS.unlink(pagePdfPath);
        } catch {
          /* ignore */
        }
      } else if (pageStrategies[page] === 'flatten') {
        // A single huge page can be dozens of tiles, so the bar advances per
        // tile rather than per page — otherwise it sits still for minutes.
        const pageStart = 22 + (page / pages) * 68;
        const pageSpan = 68 / pages;
        const label = `Flattening page ${page + 1} of ${pages}`;
        send('progress', { id, progress: round1(pageStart), message: label });
        const flatten = JSON.parse(callPython('pp_begin_flatten_page', id, page));
        for (let tile = 0; tile < flatten.tiles; tile += 1) {
          callPython('pp_flatten_tile', id, tile);
          send('progress', {
            id,
            progress: round1(pageStart + pageSpan * ((tile + 1) / flatten.tiles)),
            message:
              flatten.tiles > 1 ? `${label} · tile ${tile + 1} of ${flatten.tiles}` : label,
          });
        }
        callPython('pp_finish_flatten_page', id, analysis.usable);
        if (analysis.usable) textSummary.rebuiltPages += 1;
        else textSummary.imageOnlyPages += 1;
      } else {
        send('progress', {
          id,
          progress: round1(22 + ((page + 1) / pages) * 68),
          message: `Preserving page ${page + 1} of ${pages}`,
        });
        callPython('pp_copy_original_page', id, page, page === lastOriginalPage);
        if (analysis.usable) textSummary.nativePages += 1;
        else textSummary.imageOnlyPages += 1;
      }
    }
    if (opened.hasLinks) {
      const links = JSON.parse(callPython('pp_copy_rebuilt_links', id));
      if (links.warning) send('warning', { id, message: links.warning });
    }
    send('progress', {
      id,
      progress: 92,
      message:
        pageStrategies.every((strategy) => strategy === 'flatten')
          ? 'Optimising flattened PDF'
          : 'Optimising PDF structure and embedded resources',
    });
    const finalized = JSON.parse(
      callPython('pp_finalize', id, outputPath, nativePages.length > 0),
    );
    if (finalized.warning) send('warning', { id, message: finalized.warning });
    await terminateOCR();

    const usedOriginal = finalized.size >= file.size && textSummary.ocrPages === 0;
    const resultTextSummary = usedOriginal
      ? {
          nativePages: analyses.filter((analysis) => analysis.usable).length,
          rebuiltPages: 0,
          ocrPages: 0,
          imageOnlyPages: analyses.filter((analysis) => !analysis.usable).length,
        }
      : textSummary;
    if (finalized.size >= file.size && textSummary.ocrPages > 0) {
      send('warning', {
        id,
        message: 'Searchable text was added, but the resulting PDF is larger than the source.',
      });
    }
    const metadata = {
      originalName: file.name,
      originalSize: file.size,
      settings,
      textSummary: resultTextSummary,
      usedOriginal,
    };
    await deliverPdfResult({
      jobId: id,
      sourcePath: usedOriginal ? mounted.inputPath : outputPath,
      outputName,
      metadata,
      pages,
      textSummary: resultTextSummary,
      usedOriginal,
      opfsAvailable,
    });
  } catch (error) {
    await terminateOCR();
    send('job-error', {
      id,
      message: safeMessage(error),
      stack: error instanceof Error && error.stack ? error.stack : '',
    });
  } finally {
    try {
      callPython('pp_close', id);
    } catch {
      /* ignore */
    }
    if (mounted) unmountInput(mounted.mountPath);
    if (outputPath) {
      try {
        pyodide.FS.unlink(outputPath);
      } catch {
        /* ignore */
      }
    }
    if (staged) await removeStagedInput(id);
  }
}

async function removeStagedInput(jobId: string): Promise<void> {
  if (!navigator.storage || !navigator.storage.getDirectory) return;
  try {
    const root: any = await navigator.storage.getDirectory();
    const pixelpress = await root.getDirectoryHandle('pixelpress');
    const jobs = await pixelpress.getDirectoryHandle('jobs');
    const directory = await jobs.getDirectoryHandle(jobId);
    await directory.removeEntry('input.pdf');
  } catch {
    /* ignore */
  }
}

async function removeOPFSJob(id: string): Promise<void> {
  if (!navigator.storage || !navigator.storage.getDirectory) return;
  try {
    const root: any = await navigator.storage.getDirectory();
    const pixelpress = await root.getDirectoryHandle('pixelpress');
    const jobs = await pixelpress.getDirectoryHandle('jobs');
    await jobs.removeEntry(id, { recursive: true });
  } catch {
    /* ignore */
  }
}

self.onmessage = async (event: MessageEvent<WorkerInbound>) => {
  const data = event.data;
  if (!data) return;
  if (data.type === 'process') await processJob(data);
  if (data.type === 'remove') await removeOPFSJob(data.id);
};

self.postMessage({ type: 'runtime', status: 'loading', message: 'Worker connected' });
void boot();
