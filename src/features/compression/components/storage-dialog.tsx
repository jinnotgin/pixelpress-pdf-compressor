import { useEffect, useRef, useState } from 'react';

import { Icon } from '@/components/ui/icon';
import { formatBytes } from '@/utils/format';

import { HISTORY_MAX_AGE_DAYS } from '../config';
import { type StorageUsage } from '../services/storage-usage';

interface StorageDialogProps {
  open: boolean;
  onClose: () => void;
  usage: StorageUsage | null;
  /** A job is mid-run, so the files under it must not be pulled away. */
  busy: boolean;
  onClearResults: () => Promise<void>;
}

interface Segment {
  key: string;
  label: string;
  detail: string;
  bytes: number;
}

export function StorageDialog({
  open,
  onClose,
  usage,
  busy,
  onClearResults,
}: StorageDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  // `<dialog>` owns the focus trap, Esc handling and the backdrop; the `open`
  // prop just drives it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) setConfirming(false);
  }, [open]);

  const runClear = async () => {
    setWorking(true);
    try {
      await onClearResults();
    } finally {
      setWorking(false);
      setConfirming(false);
    }
  };

  const segments: Segment[] = usage
    ? [
        {
          key: 'results',
          label: 'Processed PDFs',
          detail: usage.results.count
            ? `${usage.results.count} ${usage.results.count === 1 ? 'file' : 'files'}, kept for ${HISTORY_MAX_AGE_DAYS} days`
            : 'Nothing processed yet',
          bytes: usage.results.bytes,
        },
        {
          key: 'models',
          label: 'Text recognition models',
          detail: 'Downloaded once per language, then reused offline',
          bytes: usage.models,
        },
        {
          key: 'engine',
          label: 'Cached engine files',
          detail: 'The Python and PDF engine the browser saved for faster starts',
          bytes: usage.engine,
        },
        {
          key: 'stray',
          label: 'Leftover working files',
          detail: 'From a run that was interrupted; cleared along with your PDFs',
          bytes: usage.strayLocal,
        },
        {
          key: 'other',
          // Without `usageDetails` this bucket is the engine and the models as
          // well, so it must not claim to be the untouchable remainder.
          label: usage.detailed ? 'Other site data' : 'Cached downloads and other site data',
          detail: usage.detailed
            ? 'Only clearable from your browser settings'
            : 'Includes the cached engine and models, which is only clearable from your browser settings',

          bytes: usage.other,
        },
      ].filter((segment) => segment.bytes > 0 || segment.key === 'results')
    : [];

  const total = usage?.usage ?? 0;
  // Interrupted runs leave working files behind that nothing else would ever
  // remove, so the one delete action covers them alongside the finished PDFs.
  const deletable = usage ? usage.results.bytes + usage.strayLocal : 0;
  const count = usage?.results.count ?? 0;
  const confirmCopy = count
    ? `Delete ${count} processed ${count === 1 ? 'PDF' : 'PDFs'}? Anything you have not downloaded yet is gone for good.`
    : 'Delete the leftover working files kept on this device?';

  return (
    <dialog className="storage-dialog" ref={dialogRef} onClose={onClose} aria-labelledby="storage-dialog-title">
      <div className="storage-head">
        <div>
          <h2 id="storage-dialog-title">Browser storage</h2>
          <p>Everything PixelPress keeps stays on this device. Nothing here has been uploaded.</p>
        </div>
        <button className="icon-button quiet" type="button" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </div>

      {usage ? (
        <>
          <div className="storage-total">
            <strong>{formatBytes(total)}</strong>
            <span>used of {formatBytes(usage.quota)} available to this site</span>
          </div>
          {/* The bar splits what is in use, not the quota: the quota runs to
              gigabytes, so a share-of-quota bar would be a sliver of nothing. */}
          <div
            className="storage-meter"
            role="img"
            aria-label={`${formatBytes(total)} of ${formatBytes(usage.quota)} used`}
          >
            {segments.map((segment) => (
              <span
                key={segment.key}
                className={`storage-meter-part is-${segment.key}`}
                style={{ flexGrow: Math.max(segment.bytes, 0) }}
              />
            ))}
          </div>

          <ul className="storage-breakdown">
            {segments.map((segment) => (
              <li key={segment.key}>
                <span className={`storage-swatch is-${segment.key}`} aria-hidden="true" />
                <span className="storage-copy">
                  <strong>{segment.label}</strong>
                  <span>{segment.detail}</span>
                </span>
                <span className="storage-size">{formatBytes(segment.bytes)}</span>
              </li>
            ))}
          </ul>

          <div className="storage-actions">
            {busy && <p className="storage-hint">Finish or cancel the running job before deleting.</p>}
            {confirming ? (
              <div className="storage-confirm">
                <p>{confirmCopy}</p>
                <div className="storage-confirm-buttons">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={working}
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="secondary-button danger"
                    type="button"
                    disabled={working}
                    onClick={() => void runClear()}
                  >
                    {working ? 'Deleting' : 'Delete'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="secondary-button"
                type="button"
                disabled={busy || working || deletable === 0}
                onClick={() => setConfirming(true)}
              >
                Delete processed PDFs
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="storage-hint">This browser does not report how much storage the site is using.</p>
      )}
    </dialog>
  );
}
