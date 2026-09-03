import { useCallback, useEffect, useRef, useState } from 'react';

import { restoreOpfsHistory } from '../services/opfs-history';
import { readOpfsFile } from '../services/opfs';
import { createPixelpressWorker, postToWorker } from '../services/worker-client';
import {
  type Job,
  type Notice,
  type RuntimeState,
  type Settings,
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

export interface CompressionQueue {
  jobs: Job[];
  runtime: RuntimeState;
  notice: Notice | null;
  storageText: string;
  addFiles: (files: FileList | File[] | null) => void;
  downloadJob: (job: Job) => void;
  removeJob: (id: string) => void;
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

  const { storageText, refresh: refreshStorage } = useStorageEstimate();

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  const updateJob = useCallback((id: string, change: Partial<Job>) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...change } : job)));
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
            setNotice({ kind: 'error', text: `The browser engine could not start: ${data.message}` });
          }
          return;
        }
        case 'progress': {
          updateJob(data.id, { status: 'processing', progress: data.progress, message: data.message });
          return;
        }
        case 'warning': {
          updateJob(data.id, { warning: data.message });
          setNotice({ kind: 'warning', text: data.message });
          return;
        }
        case 'done': {
          let downloadUrl: string | null = null;
          if (data.outputBuffer) {
            downloadUrl = URL.createObjectURL(new Blob([data.outputBuffer], { type: 'application/pdf' }));
            objectUrlsRef.current.set(data.id, downloadUrl);
          }
          updateJob(data.id, {
            status: 'done',
            progress: 100,
            message: formatTextSummary(data.textSummary, data.pages),
            textSummary: data.textSummary ?? null,
            outputName: data.outputName,
            outputSize: data.outputSize,
            opfsPath: data.opfsPath ?? null,
            downloadUrl,
          });
          processingRef.current = false;
          activeRef.current = null;
          return;
        }
        case 'job-error': {
          updateJob(data.id, { status: 'error', message: data.message, progress: 0 });
          processingRef.current = false;
          activeRef.current = null;
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
  }, [updateJob]);

  const restoreHistory = useCallback(async () => {
    const restored = await restoreOpfsHistory();
    if (restored.length) setJobs((current) => [...current, ...restored]);
    refreshStorage();
  }, [refreshStorage]);

  // Boot the worker; restore history exactly once even under StrictMode's
  // double-invoke (appending restored jobs is not idempotent).
  useEffect(() => {
    startWorker();
    refreshStorage();
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
    updateJob(next.id, { status: 'processing', progress: 1, message: 'Sending file to the local worker' });
    postToWorker(workerRef.current, {
      type: 'process',
      id: next.id,
      file: next.file,
      settings: next.settings,
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

  const cancelJob = useCallback(
    (id: string) => {
      if (activeRef.current !== id) return;
      workerRef.current?.terminate();
      processingRef.current = false;
      activeRef.current = null;
      updateJob(id, {
        status: 'cancelled',
        message: 'Cancelled, partial local files can be removed',
        progress: 0,
      });
      startWorker();
    },
    [startWorker, updateJob],
  );

  const retryJob = useCallback(
    (id: string) => {
      updateJob(id, { status: 'pending', message: 'Waiting to retry', progress: 0 });
      if (runtime.status === 'error') startWorker();
    },
    [runtime.status, startWorker, updateJob],
  );

  const clearFinished = useCallback(() => {
    jobsRef.current.filter((job) => isRemovable(job.status)).forEach((job) => {
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
    addFiles,
    downloadJob,
    removeJob,
    cancelJob,
    retryJob,
    clearFinished,
  };
}
