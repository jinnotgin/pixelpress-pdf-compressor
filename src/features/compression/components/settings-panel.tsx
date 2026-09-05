import { Icon } from '@/components/ui/icon';

import { IMAGE_DETAIL_OPTIONS, OCR_LANGUAGE_OPTIONS } from '../config';
import { type SettingsUpdater } from '../hooks/use-persistent-settings';
import {
  type ImageDetail,
  type OcrLanguage,
  type Preset,
  type RuntimeState,
  type Settings,
  type Strategy,
} from '../types';
import {
  DEFAULT_SETTINGS,
  IMAGE_DETAIL_COPY,
  PRESET_COPY,
  STRATEGY_COPY,
  resolveSettings,
} from '../utils/settings';
import { RadioGroup } from './radio-group';
import { RangeControl } from './range-control';

interface SettingsPanelProps {
  settings: Settings;
  setSettings: SettingsUpdater;
  open: boolean;
  setOpen: (open: boolean) => void;
  runtime: RuntimeState;
  storageText: string;
  onOpenStorage: () => void;
}

export function SettingsPanel({
  settings,
  setSettings,
  open,
  setOpen,
  runtime,
  storageText,
  onOpenStorage,
}: SettingsPanelProps) {
  const patch = (change: Partial<Settings>) => setSettings((current) => ({ ...current, ...change }));

  // Entering Custom clones the resolution and quality the active preset
  // actually runs, so the sliders open on the values you were just using
  // instead of stale ones. Strategy always starts at Auto, so Custom opens on
  // the same neutral choice no matter which preset you came from.
  const resolved = resolveSettings(settings);
  const choosePreset = (value: Preset) =>
    patch(
      value === 'custom'
        ? {
            preset: value,
            strategy: 'auto',
            flattenDpi: resolved.flattenDpi,
            imageDetail: resolved.imageDetail,
            jpegQuality: resolved.jpegQuality,
          }
        : { preset: value },
    );

  return (
    <aside className={`settings-panel ${open ? 'open' : ''}`} aria-label="Compression settings">
      <div className="brand-row">
        <div className="brand-mark">
          <Icon name="compress" size={21} />
        </div>
        <div className="brand-copy">
          <h1 className="brand-name">PixelPress</h1>
          <p className="brand-mode">Local PDF Compressor</p>
        </div>
        <button
          className="settings-toggle"
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <Icon name="settings" size={16} />
          <span>Settings</span>
        </button>
      </div>
      <div className="settings-scroll">
        <div className="privacy-note">
          <Icon name="lock" size={21} />
          <div>
            <strong>Your files are safe</strong>
            <p>Processing happens locally on-device. Nothing is uploaded to the cloud.</p>
          </div>
        </div>
        <form className="settings-form" onSubmit={(event) => event.preventDefault()}>
          {/* The preset picker carries no section heading of its own; it reads as a
              single labelled control, matching Strategy below. */}
          <section className="form-section">
            <span className="sub-label" id="preset-label">
              <span>Compression</span>
            </span>
            <div className="strategy-group">
              <RadioGroup
                name="preset"
                labelledBy="preset-label"
                value={settings.preset}
                onChange={(value) => choosePreset(value as Preset)}
                columns={3}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'figma', label: 'Figma' },
                  { value: 'custom', label: 'Custom' },
                ]}
              />
            </div>
            <p className="preset-note">{PRESET_COPY[settings.preset]}</p>
          </section>
          {settings.preset === 'custom' && (
            <section className="form-section" aria-labelledby="compression-settings-label">
              <h2 className="section-label" id="compression-settings-label">
                Compression settings
              </h2>
              <div className="control-stack">
                <div>
                  <span className="sub-label" id="strategy-label">
                    <span>Strategy</span>
                  </span>
                  <div className="strategy-group">
                    <RadioGroup
                      name="strategy"
                      labelledBy="strategy-label"
                      value={settings.strategy}
                      onChange={(value) => patch({ strategy: value as Strategy })}
                      columns={3}
                      options={[
                        { value: 'auto', label: 'Hybrid' },
                        { value: 'optimize', label: 'Preserve' },
                        { value: 'flatten', label: 'Flatten' },
                      ]}
                    />
                  </div>
                  <p className="preset-note">{STRATEGY_COPY[settings.strategy]}</p>
                </div>
                {settings.strategy !== 'optimize' && (
                  <RangeControl
                    id="flatten-dpi"
                    label="Page raster resolution"
                    value={settings.flattenDpi}
                    min={48}
                    max={300}
                    unit=" DPI"
                    hint="Flattened pages become images at this resolution. Lower = smaller file size"
                    onChange={(value) => patch({ flattenDpi: value })}
                  />
                )}
                {settings.strategy !== 'flatten' && (
                  <div>
                    <span className="sub-label" id="image-detail-label">
                      <span>Embedded image detail</span>
                    </span>
                    <div className="strategy-group">
                      <RadioGroup
                        name="image-detail"
                        labelledBy="image-detail-label"
                        value={settings.imageDetail}
                        onChange={(value) => patch({ imageDetail: value as ImageDetail })}
                        columns={3}
                        options={IMAGE_DETAIL_OPTIONS.map(({ value, label }) => ({ value, label }))}
                      />
                    </div>
                    <p className="preset-note">{IMAGE_DETAIL_COPY[settings.imageDetail]}</p>
                  </div>
                )}
                <RangeControl
                  id="jpeg-quality"
                  label="JPEG quality"
                  value={settings.jpegQuality}
                  min={35}
                  max={95}
                  unit="%"
                  hint="Lower = smaller file size"
                  onChange={(value) => patch({ jpegQuality: value })}
                />
              </div>
            </section>
          )}
          <section className="form-section" aria-labelledby="searchable-text-label">
            <h2 className="section-label" id="searchable-text-label">
              Searchable text
            </h2>
            <div className="ocr-controls">
              <label className="check-control">
                <input
                  type="checkbox"
                  checked={settings.recognizeText}
                  onChange={(event) => patch({ recognizeText: event.target.checked })}
                />
                <span className="check-copy">
                  <strong>Recognise missing text</strong>
                  <span>If a page has no selectable text, apply text recognition processing to make it searchable.</span>
                </span>
              </label>
              <label className={`language-control ${settings.recognizeText ? '' : 'disabled-copy'}`}>
                <span className="sub-label">Recognition language</span>
                <select
                  value={settings.ocrLanguage}
                  disabled={!settings.recognizeText}
                  onChange={(event) => patch({ ocrLanguage: event.target.value as OcrLanguage })}
                >
                  {OCR_LANGUAGE_OPTIONS.map((language) => (
                    <option key={language.value} value={language.value}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>
          <div className="form-actions">
            <button
              className="secondary-button full"
              type="button"
              onClick={() => setSettings(DEFAULT_SETTINGS)}
            >
              Reset to default
            </button>
          </div>
        </form>
      </div>
      <footer className="settings-footer">
        <div className="runtime-line">
          <span className="runtime-label">
            <span className={`status-dot ${runtime.status}`} />
            {runtime.message}
          </span>
        </div>
        <button className="storage-line" type="button" onClick={onOpenStorage}>
          <span>{storageText}</span>
          <Icon name="chevron" size={14} />
        </button>
      </footer>
    </aside>
  );
}
