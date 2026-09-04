import { Icon } from '@/components/ui/icon';
import { formatBytes } from '@/utils/format';

import { IMAGE_DETAIL_LABELS } from '../config';
import { type Job } from '../types';
import { isRemovable, savingsPercent } from '../utils/jobs';

interface JobRowProps {
  job: Job;
  onDownload: (job: Job) => void;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}

export function JobRow({ job, onDownload, onCancel, onRemove, onRetry }: JobRowProps) {
  const savings = savingsPercent(job);
  const active = job.status === 'processing';
  const running = active || job.status === 'pending';
  const removable = isRemovable(job.status);
  const custom = job.settings.preset === 'custom';
  const strategyLabel = {
    auto: 'Auto',
    flatten: 'Flatten',
    optimize: 'Preserve',
  }[job.settings.strategy];
  // Auto runs both branches, so it is the one strategy that has to show both.
  // The two are not comparable units: pages carry a resolution, embedded images
  // carry a detail step, so neither can stand in for the other.
  const imageDetailLabel = IMAGE_DETAIL_LABELS[job.settings.imageDetail];
  const dpiLabel =
    job.settings.strategy === 'flatten'
      ? `${job.settings.flattenDpi} DPI pages`
      : job.settings.strategy === 'optimize'
        ? `${imageDetailLabel} images`
        : `${job.settings.flattenDpi} DPI pages, ${imageDetailLabel} images`;

  return (
    <article className="job-row" aria-live="polite">
      <div className="file-glyph">PDF</div>
      <div className="job-main">
        <div className="job-title-line">
          <span className="job-name" title={job.name}>
            {job.name}
          </span>
          <span className={`status-chip ${job.status}`}>{job.status}</span>
        </div>
        <div className="job-metadata">
          <span
            className="size-change"
            title={job.outputSize != null ? 'Original size, then compressed size' : 'Original size'}
          >
            {formatBytes(job.originalSize)}
            {job.outputSize != null && (
              <>
                <span className="size-arrow">→</span>
                <span className="result-size">{formatBytes(job.outputSize)}</span>
              </>
            )}
          </span>
          {job.usedOriginal && <span className="savings">Already compact</span>}
          {savings != null && !job.usedOriginal && (
            <span className={`savings ${savings < 0 ? 'negative' : ''}`}>
              {savings >= 0 ? `${savings}% smaller` : `${Math.abs(savings)}% larger`}
            </span>
          )}
          <span>{job.settings.preset[0].toUpperCase() + job.settings.preset.slice(1)}</span>
          {custom && <span>{strategyLabel}</span>}
          {custom && <span>{dpiLabel}</span>}
          {custom && <span>JPEG {job.settings.jpegQuality}%</span>}
        </div>
        {running && (
          <div className="progress-track" aria-label={`${Math.round(job.progress)}% complete`}>
            <div className="progress-fill" style={{ transform: `scaleX(${job.progress / 100})` }} />
          </div>
        )}
        {(job.status !== 'done' || job.usedOriginal) && (
          <p className={`job-detail ${job.status === 'error' ? 'error' : ''}`}>{job.message}</p>
        )}
        {job.warning && (
          <p className="job-warning">
            <Icon name="info" size={14} />
            <span>{job.warning}</span>
          </p>
        )}
      </div>
      <div className="job-actions">
        {job.status === 'done' && (
          <button className="primary-button" type="button" onClick={() => onDownload(job)}>
            <Icon name="download" size={16} />
            <span>Download</span>
          </button>
        )}
        {active && (
          <button className="secondary-button" type="button" onClick={() => onCancel(job.id)}>
            Cancel
          </button>
        )}
        {job.status === 'error' && (
          <button className="secondary-button" type="button" onClick={() => onRetry(job.id)}>
            <Icon name="retry" size={15} />
            <span className="sr-only">Retry</span>
          </button>
        )}
        {removable && (
          <button className="text-button danger" type="button" onClick={() => onRemove(job.id)}>
            Remove
          </button>
        )}
      </div>
    </article>
  );
}
