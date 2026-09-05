import { useCallback, useEffect, useRef, useState } from 'react';

import { restoreOpfsHistory } from '../services/opfs-history';
import { readOpfsFile } from '../services/opfs';
import { clearLocalFiles, deleteStoredJob, type StorageUsage } from '../services/storage-usage';
import { createPixelpressWorker, postToWorker } from '../services/worker-client';
import {
  type Job,
  type Notice,
  type RuntimeState,
  type Settings,
  type StrategyDebugReport,
  type WorkerFallback,
  type WorkerOutbound,
} from '../types';
import { intakeFiles, isRemovable } from '../utils/jobs';
import { resolveSettings } from '../utils/settings';
import { formatTextSummary } from '../utils/text-summary';
import { useStorageEstimate } from './use-storage-estimate';

const INITIAL_RUNTIME: RuntimeState = {
  status: 'loading',
  message: 'Starting browser engine',
  opfs: false,
};

function logStrategyDebug(report: StrategyDebugReport): void {
  console.groupCollapsed('[PixelPress strategy] Auto decision report');
  console.info(report.documentReason);
  console.info('Detected PDF features:', report.documentFeatures);
  console.info('Auto thresholds and copyable report:', report);
  if (report.pages.length) {
    console.table(
      report.pages.map((page) => ({
        page: page.page,
        action: page.finalAction,
        decision: page.decision,
        reason: page.reason,
        usableText: page.usableText,
        words: page.words,
        characters: page.characters,
        imageCoverage: `${page.largestImageCoveragePercent}%`,
        contentBytes: page.contentStreamBytes,
        protected: page.protected,
        imageBelow55: page.checks.imageCoverageBelow55Percent,
        contentAtLeast220KB: page.checks.contentAtLeast220KB,
        wordsBelow120: page.checks.fewerThan120Words,
        contentAtLeast700KB: page.checks.contentAtLeast700KB,
      })),
    );
  }
  console.groupEnd();
}

export interface CompressionQueue {
  jobs: Job[];
  runtime: RuntimeState;
  notice: Notice | null;
  storageText: string;
  storage: StorageUsage | null;
  refreshStorage: () => Promise<void>;
  /** Deletes every local file kept in OPFS, and drops the results from the queue. */
  clearStorageResults: () => Promise<void>;
  addFiles: (files: FileList | File[] | null) => void;
  downloadJob: (job: Job) => void;
  removeJob: (id: string) => void;
  /** Stops a running job and drops it entirely — row and local files alike. */
  cancelJob: (id: string) => void;
  retryJob: (id: string) => void;
  clearFinished: () => void;
}

/**
 * Owns the whole processing pipeline: the Web Worker lifecycle, the job queue,
 * OPFS history restore, storage accounting, and the object URLs handed to the
 * download button. UI-only state (settings drawer, drag hover) lives in the
 * components.
 */
export function useCompressionQueue(settings: Settings): CompressionQueue {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [runtime, setRuntime] = useState<RuntimeState>(INITIAL_RUNTIME);
  const [notice, setNotice] = useState<Notice | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const activeRef = useRef<string | null>(null);
  const processingRef = useRef(false);
  const jobsRef = useRef<Job[]>(jobs);
  const objectUrlsRef = useRef<Map<string, string>>(new Map());
  const historyRestoredRef = useRef(false);
  const restartWorkerRef = useRef<() => void>(() => {});

  const { storageText, usage: storage, refresh: refreshStorage } = useStorageEstimate();

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  const updateJob = useCallback((id: string, change: Partial<Job>) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...change } : job)));
  }, []);

  // Progress is a backstop against the worker's phases overlapping: the bar only
  // ever moves forward, so a phase that reports a lower percentage than the one
  // before it just holds position instead of visibly rewinding.
  const advanceJob = useCallback((id: string, progress: number, message: string) => {
    setJobs((current) =>
      current.map((job): Job =>
        job.id === id
          ? { ...job, status: 'processing', progress: Math.max(job.progress, progress), message }
          : job,
      ),
    );
  }, []);

  const startWorker = useCallback(() => {
    workerRef.current?.terminate();
    setRuntime(INITIAL_RUNTIME);

    const worker = createPixelpressWorker();
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const data = event.data;
      switch (data.type) {
        case 'runtime': {
          setRuntime({ status: data.status, message: data.message, opfs: Boolean(data.opfs) });
          if (data.status === 'error') {
            setNotice({
              kind: 'error',
              text: `The browser engine could not start: ${data.message}`,
            });
          }
          return;
        }
        case 'progress': {
          advanceJob(data.id, data.progress, data.message);
          return;
        }
        case 'warning': {
          updateJob(data.id, { warning: data.message });
          return;
        }
        case 'strategy-debug': {
          logStrategyDebug(data.report);
          return;
        }
        case 'done': {
          let downloadUrl: string | null = null;
          if (data.outputBuffer) {
            downloadUrl = URL.createObjectURL(
              new Blob([data.outputBuffer], { type: 'application/pdf' }),
            );
            objectUrlsRef.current.set(data.id, downloadUrl);
          }
          updateJob(data.id, {
            status: 'done',
            progress: 100,
            message: formatTextSummary(data.textSummary, data.pages, data.usedOriginal),
            textSummary: data.textSummary ?? null,
            outputName: data.outputName,
            outputSize: data.outputSize,
            opfsPath: data.opfsPath ?? null,
            downloadUrl,
            usedOriginal: data.usedOriginal,
          });
          processingRef.current = false;
          activeRef.current = null;
          return;
        }
        case 'job-error': {
          const job = jobsRef.current.find((candidate) => candidate.id === data.id);
          const fallback = data.fallback;
          if (fallback && job?.file && !job.workerFallbacks?.includes(fallback)) {
            const fallbackMessage =
              fallback === 'skip-ocr'
                ? 'Restarting safely without text recognition'
                : 'Restarting safely without embedded-image rewriting';
            const nextFallbacks: WorkerFallback[] = [...(job.workerFallbacks ?? []), fallback];
            setJobs((current) =>
              current.map((candidate) =>
                candidate.id === data.id
                  ? {
                      ...candidate,
                      status: 'pending',
                      progress: 0,
                      message: fallbackMessage,
                      workerFallbacks: nextFallbacks,
                    }
                  : candidate,
              ),
            );
            processingRef.current = false;
            activeRef.current = null;
            worker.terminate();
            if (workerRef.current === worker) workerRef.current = null;
            setRuntime({
              status: 'loading',
              message: 'Restarting browser engine for a safe retry',
              opfs: false,
            });
            queueMicrotask(() => restartWorkerRef.current());
            return;
          }
          updateJob(data.id, { status: 'error', message: data.message, progress: 0 });
          processingRef.current = false;
          activeRef.current = null;
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
          setRuntime({
            status: 'loading',
            message: 'Restarting browser engine',
            opfs: false,
          });
          queueMicrotask(() => restartWorkerRef.current());
          return;
        }
      }
    };

    worker.onerror = (event) => {
      console.error('PixelPress worker error', event.message, event.filename, event.lineno);
      const id = activeRef.current;
      if (id) {
        updateJob(id, {
          status: 'error',
          message: event.message || 'The processing worker stopped unexpectedly.',
          progress: 0,
        });
      }
      processingRef.current = false;
      activeRef.current = null;
      setRuntime({ status: 'error', message: 'Browser engine stopped', opfs: false });
    };
  }, [advanceJob, updateJob]);

  restartWorkerRef.current = startWorker;

  const restoreHistory = useCallback(async () => {
    const restored = await restoreOpfsHistory();
    if (restored.length) setJobs((current) => [...current, ...restored]);
    await refreshStorage();
  }, [refreshStorage]);

  // Boot the worker; restore history exactly once even under StrictMode's
  // double-invoke (appending restored jobs is not idempotent).
  useEffect(() => {
    startWorker();
    void refreshStorage();
    if (!historyRestoredRef.current) {
      historyRestoredRef.current = true;
      void restoreHistory();
    }

    const urls = objectUrlsRef.current;
    return () => {
      workerRef.current?.terminate();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [startWorker, refreshStorage, restoreHistory]);

  // Pump the queue: one pending job at a time, once the runtime is ready.
  useEffect(() => {
    if (runtime.status !== 'ready' || processingRef.current) return;
    const next = jobs.find((job) => job.status === 'pending' && job.file);
    if (!next?.file || !workerRef.current) return;

    processingRef.current = true;
    activeRef.current = next.id;
    updateJob(next.id, {
      status: 'processing',
      progress: 1,
      message: 'Sending file to the local worker',
    });
    postToWorker(workerRef.current, {
      type: 'process',
      id: next.id,
      file: next.file,
      settings: next.settings,
      fallbacks: next.workerFallbacks,
    });
  }, [jobs, runtime.status, updateJob]);

  const addFiles = useCallback(
    (fileList: FileList | File[] | null) => {
      const { accepted, rejected } = intakeFiles(fileList, resolveSettings(settings));
      if (accepted.length) {
        setJobs((current) => [...accepted, ...current]);
        setNotice(null);
        navigator.storage?.persist?.().catch(() => {});
      }
      if (rejected.length) setNotice({ kind: 'warning', text: rejected.join('. ') });
    },
    [settings],
  );

  const downloadJob = useCallback(async (job: Job) => {
    try {
      let url = job.downloadUrl ?? undefined;
      if (!url && job.opfsPath) {
        url = URL.createObjectURL(await readOpfsFile(job.opfsPath));
      }
      if (!url) throw new Error('The local output could not be found.');

      const href = url;
      const link = document.createElement('a');
      link.href = href;
      link.download = job.outputName ?? 'document-pixelpress.pdf';
      document.body.appendChild(link);
      link.click();
      link.remove();
      if (!job.downloadUrl) setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (error) {
      setNotice({
        kind: 'error',
        text: `Download failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, []);

  const removeJob = useCallback((id: string) => {
    const url = objectUrlsRef.current.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(id);
    }
    if (workerRef.current) postToWorker(workerRef.current, { type: 'remove', id });
    setJobs((current) => current.filter((job) => job.id !== id));
  }, []);

  // A cancelled run leaves nothing worth keeping, so the job goes away for good:
  // the worker mid-write is terminated, the row disappears, and the folder it
  // was filling is deleted once the terminate has released its file handles.
  const cancelJob = useCallback(
    (id: string) => {
      const active = activeRef.current === id;
      if (active) {
        workerRef.current?.terminate();
        workerRef.current = null;
        processingRef.current = false;
        activeRef.current = null;
      }

      const url = objectUrlsRef.current.get(id);
      if (url) {
        URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(id);
      }
      setJobs((current) => current.filter((job) => job.id !== id));

      if (active) startWorker();
      void deleteStoredJob(id).then(refreshStorage);
    },
    [refreshStorage, startWorker],
  );

  const retryJob = useCallback(
    (id: string) => {
      updateJob(id, {
        status: 'pending',
        message: runtime.status === 'ready' ? 'Waiting to retry' : 'Waiting for the browser engine',
        progress: 0,
      });
      if (runtime.status === 'error' || !workerRef.current) startWorker();
    },
    [runtime.status, startWorker, updateJob],
  );

  // Quota accounting settles a moment after a delete lands, so an estimate taken
  // straight afterwards can still report the bytes that just went away.
  const refreshAfterClear = useCallback(async () => {
    await refreshStorage();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await refreshStorage();
  }, [refreshStorage]);

  // Wipes the whole OPFS tree rather than one folder at a time, so the callers
  // must keep it out of reach while a job is still writing into it.
  const clearStorageResults = useCallback(async () => {
    await clearLocalFiles();
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current.clear();
    setJobs((current) => current.filter((job) => !isRemovable(job.status)));
    await refreshAfterClear();
  }, [refreshAfterClear]);

  const clearFinished = useCallback(() => {
    jobsRef.current
      .filter((job) => isRemovable(job.status))
      .forEach((job) => {
        const url = objectUrlsRef.current.get(job.id);
        if (url) URL.revokeObjectURL(url);
        if (workerRef.current) postToWorker(workerRef.current, { type: 'remove', id: job.id });
      });
    setJobs((current) => current.filter((job) => !isRemovable(job.status)));
    objectUrlsRef.current.clear();
  }, []);

  return {
    jobs,
    runtime,
    notice,
    storageText,
    storage,
    refreshStorage,
    clearStorageResults,
    addFiles,
    downloadJob,
    removeJob,
    cancelJob,
    retryJob,
    clearFinished,
  };
}
