import { useState } from 'react';

import { Notice } from '@/components/ui/notice';
import { env } from '@/config/env';

import { HISTORY_MAX_AGE_DAYS } from '../config';
import { useCompressionQueue } from '../hooks/use-compression-queue';
import { usePersistentSettings } from '../hooks/use-persistent-settings';
import { isRemovable } from '../utils/jobs';
import { DropZone } from './drop-zone';
import { JobRow } from './job-row';
import { SettingsPanel } from './settings-panel';

export function CompressionApp() {
  const [settings, setSettings] = usePersistentSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  const { jobs, runtime, notice, storageText, addFiles, downloadJob, removeJob, cancelJob, retryJob, clearFinished } =
    useCompressionQueue(settings);

  const isEmpty = jobs.length === 0;
  const clearable = jobs.some((job) => isRemovable(job.status));

  return (
    <div className="app-shell">
      <SettingsPanel
        settings={settings}
        setSettings={setSettings}
        open={settingsOpen}
        setOpen={setSettingsOpen}
        runtime={runtime}
        storageText={storageText}
      />
      <main className="workspace">
        <div className={`workspace-body ${isEmpty ? 'is-empty' : ''}`}>
          <div className="content-width notice-stack">
            {runtime.status === 'loading' && (
              <Notice icon="info">
                Loading Python and the PDF engine. You can choose files once it is ready.
              </Notice>
            )}
            {notice && (
              <Notice kind={notice.kind} icon="info">
                {notice.text}
              </Notice>
            )}
          </div>
          <div className="content-width main-stack">
            {isEmpty ? (
              <DropZone dragging={dragging} onDrag={setDragging} onFiles={addFiles} />
            ) : (
              <>
                <DropZone compact dragging={dragging} onDrag={setDragging} onFiles={addFiles} />
                <div className="queue-head">
                  <div>
                    <h2>Files</h2>
                    <p>
                      Each file keeps the settings active when it was added. Results stay on this
                      device for {HISTORY_MAX_AGE_DAYS} days.
                    </p>
                  </div>
                  <button
                    className="text-button"
                    type="button"
                    onClick={clearFinished}
                    disabled={!clearable}
                  >
                    Clear finished
                  </button>
                </div>
                <section className="queue-list" aria-label="PDF processing queue">
                  {jobs.map((job) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      onDownload={downloadJob}
                      onCancel={cancelJob}
                      onRemove={removeJob}
                      onRetry={retryJob}
                    />
                  ))}
                </section>
              </>
            )}
          </div>
        </div>
        <footer className="workspace-footer">
          <span>
            Made by{' '}
            <a href="https://itsjin.com" target="_blank" rel="noopener noreferrer">
              Jin
            </a>
          </span>
          <span className="version">v{env.APP_VERSION}</span>
        </footer>
      </main>
    </div>
  );
}
