import { MAX_FILE_BYTES, REMOVABLE_STATUSES } from '../config';
import { type Job, type JobStatus, type ResolvedSettings } from '../types';

export function createJobId(): string {
  return `job-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

export function isRemovable(status: JobStatus): boolean {
  return REMOVABLE_STATUSES.includes(status);
}

/** `null` when there is no result yet; otherwise percent saved (may be negative). */
export function savingsPercent(job: Pick<Job, 'originalSize' | 'outputSize'>): number | null {
  if (job.outputSize == null || !job.originalSize) return null;
  return Math.round((1 - job.outputSize / job.originalSize) * 100);
}

export type SizeComparison = 'smaller' | 'same' | 'larger';

/** Compare a completed output with its source; `null` means no result exists yet. */
export function compareSizes(
  job: Pick<Job, 'originalSize' | 'outputSize'>,
): SizeComparison | null {
  if (job.outputSize == null) return null;
  if (job.outputSize < job.originalSize) return 'smaller';
  if (job.outputSize > job.originalSize) return 'larger';
  return 'same';
}

export interface FileIntake {
  accepted: Job[];
  rejected: string[];
}

/** Validate a dropped/selected FileList against type and size rules. */
export function intakeFiles(
  fileList: FileList | File[] | null,
  settings: ResolvedSettings,
): FileIntake {
  const accepted: Job[] = [];
  const rejected: string[] = [];

  for (const file of Array.from(fileList ?? [])) {
    if (!isPdf(file)) {
      rejected.push(`${file.name} is not a PDF`);
    } else if (file.size > MAX_FILE_BYTES) {
      rejected.push(`${file.name} is larger than 250 MB`);
    } else {
      accepted.push({
        id: createJobId(),
        file,
        name: file.name,
        originalSize: file.size,
        settings,
        status: 'pending',
        progress: 0,
        message: 'Waiting for the browser engine',
      });
    }
  }

  return { accepted, rejected };
}
