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

interface Row {
  key: string;
  label: string;
  detail: string;
  bytes: number;
}

interface Tier extends Row {
  /** Sub-rows that partition this tier exactly; empty when it cannot be split. */
  items: Row[];
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

  const app = usage?.app;
  const results = app?.results;
  const workingFiles = app?.working;

  const tiers: Tier[] =
    usage && app && results && workingFiles
    ? [
        {
          key: 'app',
          label: 'Your files',
          detail: 'Kept on this device until you delete them',
          bytes: app.total,
          items: [
            {
              key: 'results',
              label: 'Processed PDFs',
              detail: results.count
                ? `${results.count} ${results.count === 1 ? 'file' : 'files'}, kept for ${HISTORY_MAX_AGE_DAYS} days`
                : 'Nothing processed yet',
              bytes: results.bytes,
            },
            {
              key: 'working',
              label: 'Working files',
              detail: 'Left behind by a run that did not finish',
              bytes: workingFiles.bytes,
            },
          ].filter((row) => row.key === 'results' || row.bytes > 0),
        },
        {
          key: 'external',
          label: 'Cached downloads and site data',
          // Pyodide's wheels are plain HTTP fetches and never reach the storage
          // estimate, so this cannot claim to be the whole engine on disk.
          detail: 'The engine and models, saved for faster starts. Only your browser settings can clear this.',
          bytes: usage.external,
          items: [],
        },
      ]
    : [];

  // Every segment of the bar is one visible row, so the picture and the list
  // cannot drift apart.
  const segments: Row[] = tiers.flatMap((tier) =>
    tier.items.length ? tier.items : [tier],
  );

  const total = usage?.usage ?? 0;
  // One tier, one delete: everything under "Your files" is what `clearLocalFiles`
  // removes, working files from an interrupted run included.
  const deletable = app?.total ?? 0;
  const count = results?.count ?? 0;
  const confirmParts: string[] = [];
  if (count) confirmParts.push(`${count} processed ${count === 1 ? 'PDF' : 'PDFs'}`);
  if (workingFiles?.bytes) confirmParts.push('the leftover working files');
  const confirmCopy = confirmParts.length
    ? `Delete ${confirmParts.join(' and ')}? Anything you have not downloaded yet is gone for good.`
    : 'Delete the files kept on this device?';

  return (
    <dialog className="storage-dialog" ref={dialogRef} onClose={onClose} aria-labelledby="storage-dialog-title">
      <div className="storage-head">
        <div>
          <h2 id="storage-dialog-title">Browser storage</h2>
          <p>PixelPress stores everything on this device. Nothing is uploaded to the cloud.</p>
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
            {tiers.map((tier) => (
              <li className="storage-tier" key={tier.key}>
                <div className="storage-tier-head">
                  <span className="storage-copy">
                    <strong>{tier.label}</strong>
                    <span>{tier.detail}</span>
                  </span>
                  <span className="storage-size">{formatBytes(tier.bytes)}</span>
                </div>
                {tier.items.length > 0 && (
                  <ul className="storage-sublist">
                    {tier.items.map((item) => (
                      <li key={item.key}>
                        <span className={`storage-swatch is-${item.key}`} aria-hidden="true" />
                        <span className="storage-copy">
                          <strong>{item.label}</strong>
                          <span>{item.detail}</span>
                        </span>
                        <span className="storage-size">{formatBytes(item.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                )}
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
                Delete my files
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
