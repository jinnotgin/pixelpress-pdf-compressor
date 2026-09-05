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
  FINALIZE_SCAN_SHARE,
  IMAGE_DETAIL_TARGETS,
  OCR_LANGUAGE_LABELS,
  OCR_RENDER_DPI,
  OPFS_CHUNK_SIZE as CHUNK_SIZE,
  ORIGINAL_KEPT_WARNING,
  PYODIDE_INDEX_URL,
  PYODIDE_MODULE_URL,
  STAGE_ESTIMATE_MS as ETA,
  TESSERACT_MODULE_URL as TESSERACT_URL,
} from '../config';
import {
  type PageAnalysis,
  type ResolvedSettings,
  type TextSummary,
  type WorkerFallback,
  type WorkerInbound,
} from '../types';
import { AUTO_STRATEGY_THRESHOLDS, explainPageStrategy } from '../utils/strategy';
import {
  type FatalRiskPhase,
  isRuntimeBoundsTrap,
  recoveryForFatalError,
} from '../utils/worker-recovery';
import { splitBand } from '../utils/progress-estimate';
import PYTHON_SOURCE from './pixelpress.py?raw';

declare const self: DedicatedWorkerGlobalScope;

let pyodide: any = null;
let ocrWorker: any = null;
let createOCRWorker: ((...args: any[]) => any) | null = null;
let ocrContext: {
  jobId: string;
  page: number;
  pages: number;
  tile: number;
  tiles: number;
  share: number;
  pagesEnd: number;
} | null = null;

function send(type: string, payload: Record<string, unknown> = {}): void {
  self.postMessage({ type, ...payload });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The fixed boundaries of the bar. Everything up to `pagesStart` costs roughly
 * the same whatever the job is doing, so those bands are constants; the split
 * of `pagesStart`-`processingEnd` between the per-page pass and finalisation
 * depends entirely on the strategy and is worked out per job by `splitBand`.
 */
const PROGRESS = {
  stageStart: 1,
  stageEnd: 4,
  analysisStart: 4,
  analysisEnd: 8,
  /** Where the per-page pass begins. Where it ends depends on the job. */
  pagesStart: 8,
  /** Where processing ends and the result is written out. */
  processingEnd: 96,
  outputStart: 96,
  outputEnd: 99,
} as const;

/**
 * How much of a page's slice is spent before OCR starts on it, per branch.
 *
 * The two branches are nothing alike in cost. Preserving copies the page into
 * the output and returns almost immediately, so giving it a large share makes
 * the bar leap forward before recognition has read a single region. Flattening
 * renders every tile at the requested DPI, which is real work worth showing.
 * OCR takes whatever is left either way.
 */
const SHARE_BEFORE_OCR = {
  preserve: 0.08,
  flatten: 0.5,
} as const;

/**
 * The single scale for the per-page pass. Every page owns an equal slice of the
 * pages band whichever branch (OCR, flatten, preserve) handles it, and
 * `fraction` is how far through that page we are, so the bar never rewinds when
 * the branch changes from one page to the next. `end` is where the band stops,
 * which the job works out from its own mix of pages.
 */
function pageProgress(page: number, pages: number, fraction: number, end: number): number {
  return round1(
    PROGRESS.pagesStart + ((page + fraction) / Math.max(pages, 1)) * (end - PROGRESS.pagesStart),
  );
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
    const opfs = Boolean(
      self.isSecureContext && navigator.storage && navigator.storage.getDirectory,
    );
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
        progress:
          PROGRESS.stageStart +
          Math.round((offset / Math.max(file.size, 1)) * (PROGRESS.stageEnd - PROGRESS.stageStart)),
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
  from: number = PROGRESS.outputStart,
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
        progress: round1(from + (offset / Math.max(size, 1)) * (PROGRESS.outputEnd - from)),
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
  progressFrom = PROGRESS.outputStart,
}: {
  jobId: string;
  sourcePath: string;
  outputName: string;
  metadata: Record<string, unknown>;
  pages: number;
  textSummary: TextSummary | null;
  usedOriginal: boolean;
  opfsAvailable: boolean;
  /** Where the copy starts on the bar. Bailing out early leaves it the rest. */
  progressFrom?: number;
}): Promise<void> {
  if (opfsAvailable) {
    try {
      const persisted = await persistMemFile(jobId, sourcePath, outputName, metadata, progressFrom);
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
  page: number,
  pages: number,
  share: number,
  pagesEnd: number,
  language: ResolvedSettings['ocrLanguage'],
): Promise<any> {
  if (ocrWorker) return ocrWorker;
  const languageLabel = OCR_LANGUAGE_LABELS[language];
  send('progress', {
    id: jobId,
    progress: pageProgress(page, pages, share, pagesEnd),
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
  ocrWorker = await createOCRWorker(language, 1, {
    logger(message: any) {
      // Tesseract keeps logging asynchronously, so a stale context (page already
      // finished) must not re-send that page's lower percentage.
      if (!ocrContext || message.status !== 'recognizing text') return;
      send('progress', {
        id: ocrContext.jobId,
        progress: pageProgress(
          ocrContext.page,
          ocrContext.pages,
          ocrContext.share +
            (1 - ocrContext.share) *
              ((ocrContext.tile + (Number(message.progress) || 0)) / ocrContext.tiles),
          ocrContext.pagesEnd,
        ),
        message: `Reading text · page ${ocrContext.page + 1} of ${ocrContext.pages}`,
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
  fallbacks?: WorkerFallback[];
}

async function processJob({ id, file, settings, fallbacks = [] }: ProcessRequest): Promise<void> {
  const opfsAvailable = Boolean(
    self.isSecureContext && navigator.storage && navigator.storage.getDirectory,
  );
  let mounted: { mountPath: string; inputPath: string } | null = null;
  let outputPath = '';
  let staged = false;
  let fatalRiskPhase: FatalRiskPhase = null;
  let runtimeTrapped = false;
  try {
    send('progress', { id, progress: PROGRESS.stageStart, message: 'Preparing local workspace' });
    if (fallbacks.includes('skip-ocr')) {
      send('warning', {
        id,
        message:
          'The PDF engine could not render a page for text recognition, so this retry continues without adding searchable text.',
      });
    } else if (fallbacks.includes('skip-image-optimization')) {
      send('warning', {
        id,
        message:
          'The PDF engine could not safely rewrite embedded images, so this retry uses structural compression only.',
      });
    }
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
        warning: message,
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
        progressFrom: PROGRESS.analysisEnd,
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
        progress:
          PROGRESS.analysisStart +
          Math.round(((page + 1) / pages) * (PROGRESS.analysisEnd - PROGRESS.analysisStart)),
        message: `Checking searchable text · page ${page + 1} of ${pages}`,
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
    const needsOcr = analyses.map(
      (analysis) => settings.recognizeText && !fallbacks.includes('skip-ocr') && !analysis.usable,
    );
    const preserveTaggedAuto =
      settings.strategy === 'auto' &&
      opened.tagged &&
      !pageStrategies.some((strategy) => strategy === 'flatten');
    const documentReason = preserveTaggedAuto
      ? 'Auto found tagged accessibility structure and no page strongly qualified for flattening.'
      : settings.strategy === 'auto'
        ? 'Auto evaluated every page against the vector-heavy thresholds.'
        : `Every page follows the explicitly selected ${settings.strategy} strategy; OCR adds a separate text layer when needed.`;
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
            ? `OCR adds text because page ${page + 1} has no usable selectable text. ${decision.reason}`
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
      await deliverOriginal(ORIGINAL_KEPT_WARNING);
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
      .filter(({ strategy }) => strategy === 'optimize')
      .map(({ page }) => page);
    const lastOriginalPage = nativePages.at(-1) ?? -1;

    // Now that every page's branch is known, the per-page pass and finalisation
    // can be sized against each other. The two strategies sit at opposite ends:
    // flattening spends everything rasterising pages and reaches no image pass,
    // while preserving copies pages in milliseconds and does its real work on
    // the embedded images afterwards. A fixed boundary would strand one of them.
    const pagesEta = pageStrategies.reduce(
      (total, strategy, page) =>
        total +
        (strategy === 'flatten' ? ETA.flattenPage : ETA.preservePage) +
        (needsOcr[page] ? ETA.ocrPage : 0),
      0,
    );
    // Only preserved pages reach the image pass; the rest is writing the file.
    // The scan that precedes it walks every page, but never runs at all when no
    // page was preserved, so both terms hang off the same condition.
    const finalizeEta =
      ETA.saveBase +
      (nativePages.length > 0 ? ETA.scanPage * pages + ETA.imagePerImage * nativePages.length : 0);
    const [pagesEnd] = splitBand(PROGRESS.pagesStart, PROGRESS.processingEnd, [
      pagesEta,
      finalizeEta,
    ]);

    for (let page = 0; page < pages; page += 1) {
      const analysis = analyses[page];
      const flattened = pageStrategies[page] === 'flatten';
      const shareBeforeOcr = flattened ? SHARE_BEFORE_OCR.flatten : SHARE_BEFORE_OCR.preserve;
      if (flattened) {
        // A single huge page can be dozens of tiles, so the bar advances per
        // tile rather than per page — otherwise it sits still for minutes.
        const label = `Flattening · page ${page + 1} of ${pages}`;
        send('progress', { id, progress: pageProgress(page, pages, 0, pagesEnd), message: label });
        const flatten = JSON.parse(callPython('pp_begin_flatten_page', id, page));
        for (let tile = 0; tile < flatten.tiles; tile += 1) {
          callPython('pp_flatten_tile', id, tile);
          send('progress', {
            id,
            progress: pageProgress(
              page,
              pages,
              ((tile + 1) / flatten.tiles) * (needsOcr[page] ? shareBeforeOcr : 1),
              pagesEnd,
            ),
            message:
              flatten.tiles > 1 ? `${label} · region ${tile + 1} of ${flatten.tiles}` : label,
          });
        }
        callPython('pp_finish_flatten_page', id, analysis.usable);
        if (!needsOcr[page]) {
          if (analysis.usable) textSummary.rebuiltPages += 1;
          else textSummary.imageOnlyPages += 1;
        }
      } else {
        send('progress', {
          id,
          progress: pageProgress(page, pages, needsOcr[page] ? shareBeforeOcr : 1, pagesEnd),
          message: `Preserving · page ${page + 1} of ${pages}`,
        });
        callPython('pp_copy_original_page', id, page, page === lastOriginalPage);
        if (!needsOcr[page]) {
          if (analysis.usable) textSummary.nativePages += 1;
          else textSummary.imageOnlyPages += 1;
        }
      }
      if (needsOcr[page]) {
        const recognizer = await getOCRWorker(
          id,
          page,
          pages,
          shareBeforeOcr,
          pagesEnd,
          settings.ocrLanguage,
        );
        const plan = JSON.parse(callPython('pp_begin_ocr', id, page, OCR_RENDER_DPI));
        await recognizer.setParameters({
          user_defined_dpi: String(plan.dpi),
        });
        const imagePath = `/tmp/pixelpress-${id}-ocr-tile.jpg`;
        const pdfPath = `/tmp/pixelpress-${id}-ocr-tile.pdf`;
        for (let tile = 0; tile < plan.tiles; tile += 1) {
          ocrContext = {
            jobId: id,
            page,
            pages,
            tile,
            tiles: plan.tiles,
            share: shareBeforeOcr,
            pagesEnd,
          };
          send('progress', {
            id,
            progress: pageProgress(
              page,
              pages,
              shareBeforeOcr + ((1 - shareBeforeOcr) * tile) / plan.tiles,
              pagesEnd,
            ),
            message: `Reading text · page ${page + 1} of ${pages} · region ${tile + 1} of ${plan.tiles}`,
          });
          try {
            fatalRiskPhase = 'ocr-render';
            callPython('pp_render_ocr_tile', id, tile, imagePath);
            fatalRiskPhase = null;
            const result = await recognizer.recognize(
              pyodide.FS.readFile(imagePath),
              { pdfTitle: file.name, pdfTextOnly: true },
              { pdf: true, text: true },
            );
            if (!result.data.pdf) {
              throw new Error('Text recognition did not produce a searchable text layer.');
            }
            pyodide.FS.writeFile(pdfPath, new Uint8Array(result.data.pdf));
            callPython('pp_append_ocr_tile', id, tile, pdfPath);
          } finally {
            ocrContext = null;
            for (const path of [imagePath, pdfPath]) {
              try {
                pyodide.FS.unlink(path);
              } catch {
                /* File may not exist yet. */
              }
            }
          }
        }
        const wordsAdded = Number(callPython('pp_finish_ocr', id));
        if (wordsAdded > 0) {
          textSummary.ocrPages += 1;
        } else {
          textSummary.imageOnlyPages += 1;
          send('warning', { id, message: `No text could be recognised on page ${page + 1}.` });
        }
      }
    }
    if (opened.hasLinks) {
      const links = JSON.parse(callPython('pp_copy_rebuilt_links', id));
      if (links.warning) send('warning', { id, message: links.warning });
    }
    const optimiseLabel = pageStrategies.every((strategy) => strategy === 'flatten')
      ? 'Optimising flattened PDF'
      : 'Optimising PDF structure and embedded resources';
    // The scan and the save are each one blocking PyMuPDF call, so the UI thread
    // animates their bands from an estimate instead. Each estimate is superseded
    // the moment a real progress message arrives.
    const estimate = (from: number, to: number, etaMs: number, message: string): void =>
      send('progress-estimate', { id, from, to, etaMs: Math.round(etaMs), message });
    // The scan runs before its own cost can be measured, so it takes a small
    // fixed cut and the stages it sizes divide up what is left.
    const scanEnd = round1(pagesEnd + (PROGRESS.processingEnd - pagesEnd) * FINALIZE_SCAN_SHARE);
    estimate(pagesEnd, scanEnd, ETA.scanPage * pages, 'Preparing pages for optimisation');
    // Only preserved pages carry embedded images worth reworking; a fully
    // flattened document has already been re-encoded page by page. OCR is text-only.
    const imageDpi =
      nativePages.length > 0 && !fallbacks.includes('skip-image-optimization')
        ? IMAGE_DETAIL_TARGETS[settings.imageDetail]
        : null;
    fatalRiskPhase = imageDpi ? 'image-optimization' : null;
    const plan = JSON.parse(callPython('pp_begin_finalize', id, imageDpi));
    // Every raster the plan found is rewritten one at a time, so the whole of
    // this stretch tracks real work; only the save after it is estimated.
    const plannedImages = Number(plan.images) || 0;
    const imagesEta = plannedImages * ETA.imagePerImage;
    const saveEta = ETA.saveBase;
    const [imagesEnd] = splitBand(scanEnd, PROGRESS.processingEnd, [imagesEta, saveEta]);
    send('progress', {
      id,
      progress: scanEnd,
      message:
        plannedImages > 0
          ? `Optimising ${plannedImages} embedded ${plannedImages === 1 ? 'image' : 'images'}`
          : optimiseLabel,
    });
    let rewrittenImages = 0;
    for (let image = 0; image < plannedImages; image += 1) {
      send('progress', {
        id,
        progress: round1(scanEnd + (image / plannedImages) * (imagesEnd - scanEnd)),
        message: `Recompressing · image ${image + 1} of ${plannedImages}`,
      });
      // A failure discards the rest of the plan, so stepping further would
      // report images that are no longer going to be touched.
      const rewritten = JSON.parse(callPython('pp_optimize_image', id, image));
      if (rewritten.stopped) break;
      if (rewritten.changed) rewrittenImages += 1;
    }
    send('image-debug', {
      id,
      report: {
        planned: plannedImages,
        rewritten: rewrittenImages,
        annotations: Number(plan.annotations) || 0,
        inline: Number(plan.inline) || 0,
        unreached: Number(plan.unreached) || 0,
      },
    });
    estimate(imagesEnd, PROGRESS.processingEnd, saveEta, 'Writing compressed PDF');
    const finalized = JSON.parse(callPython('pp_save_output', id, outputPath));
    fatalRiskPhase = null;
    if (finalized.warning) send('warning', { id, message: finalized.warning });
    if (Array.isArray(finalized.recoveredPages)) {
      for (const page of finalized.recoveredPages) {
        if (
          Number.isInteger(page) &&
          page >= 0 &&
          page < analyses.length &&
          analyses[page].usable
        ) {
          textSummary.nativePages = Math.max(0, textSummary.nativePages - 1);
          textSummary.rebuiltPages += 1;
        }
      }
    }
    await terminateOCR();

    const usedOriginal = finalized.size >= file.size && textSummary.ocrPages === 0;
    if (usedOriginal) send('warning', { id, message: ORIGINAL_KEPT_WARNING });
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
      warning: usedOriginal ? ORIGINAL_KEPT_WARNING : undefined,
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
    const fallback = recoveryForFatalError(error, fatalRiskPhase, fallbacks);
    runtimeTrapped = fatalRiskPhase !== null && isRuntimeBoundsTrap(error);
    send('job-error', {
      id,
      message: safeMessage(error),
      stack: error instanceof Error && error.stack ? error.stack : '',
      fallback,
    });
  } finally {
    // A WebAssembly bounds trap poisons the Pyodide instance. Do not call into
    // it again; the queue will replace this worker before applying the fallback.
    if (!runtimeTrapped) {
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
