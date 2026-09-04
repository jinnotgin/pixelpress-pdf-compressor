import { Icon } from '@/components/ui/icon';

import { type Preset, type RuntimeState, type Settings, type Strategy } from '../types';
import { type SettingsUpdater } from '../hooks/use-persistent-settings';
import {
  DEFAULT_SETTINGS,
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
}

export function SettingsPanel({
  settings,
  setSettings,
  open,
  setOpen,
  runtime,
  storageText,
}: SettingsPanelProps) {
  const patch = (change: Partial<Settings>) => setSettings((current) => ({ ...current, ...change }));

  // Entering Custom clones whatever the active preset actually runs, so the
  // sliders open on the values you were just using instead of stale ones.
  const resolved = resolveSettings(settings);
  const choosePreset = (value: Preset) =>
    patch(
      value === 'custom'
        ? {
            preset: value,
            strategy: resolved.strategy,
            dpi: resolved.dpi,
            jpegQuality: resolved.jpegQuality,
          }
        : { preset: value },
    );

  return (
    <aside className={`settings-panel ${open ? 'open' : ''}`} aria-label="Compression settings">
      <div className="brand-row">
        <div className="brand-mark">
          <Icon name="download" size={21} />
        </div>
        <div className="brand-copy">
          <h1 className="brand-name">PixelPress</h1>
          <p className="brand-mode">Figma PDF Compressor</p>
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
          <fieldset className="form-section">
            <legend className="section-label">Compression</legend>
            <RadioGroup
              name="preset"
              value={settings.preset}
              onChange={(value) => choosePreset(value as Preset)}
              columns={3}
              options={[
                { value: 'high', label: 'High' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'custom', label: 'Custom' },
              ]}
            />
            <p className="preset-note">{PRESET_COPY[settings.preset]}</p>
          </fieldset>
          {settings.preset === 'custom' && (
            <fieldset className="form-section control-stack">
              <legend className="section-label">Compression Settings</legend>
              <div>
                <span className="sub-label">
                  <span>Strategy</span>
                </span>
                <div className="strategy-group">
                  <RadioGroup
                    name="strategy"
                    value={settings.strategy}
                    onChange={(value) => patch({ strategy: value as Strategy })}
                    options={[
                      { value: 'flatten', label: 'Flatten pages' },
                      { value: 'optimize', label: 'Optimise images' },
                    ]}
                  />
                </div>
                <p className="preset-note">{STRATEGY_COPY[settings.strategy]}</p>
              </div>
              <RangeControl
                id="dpi"
                label="Maximum resolution"
                value={settings.dpi}
                min={48}
                max={300}
                unit=" DPI"
                hint="Lower = smaller file size"
                onChange={(value) => patch({ dpi: value })}
              />
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
            </fieldset>
          )}
          <fieldset className="form-section">
            <legend className="section-label">Searchable text</legend>
            <label className="check-control">
              <input
                type="checkbox"
                checked={settings.recognizeText}
                onChange={(event) => patch({ recognizeText: event.target.checked })}
              />
              <span className="check-copy">
                <strong>
                  Recognise missing text <span className="experimental-tag">English</span>
                </strong>
                <span>If a page has no selectable text, read it to make it searchable.</span>
              </span>
            </label>
          </fieldset>
          <button
            className="secondary-button full"
            type="button"
            onClick={() => setSettings(DEFAULT_SETTINGS)}
          >
            Reset to default
          </button>
        </form>
      </div>
      <footer className="settings-footer">
        <div className="runtime-line">
          <span className="runtime-label">
            <span className={`status-dot ${runtime.status}`} />
            {runtime.message}
          </span>
        </div>
        <div className="storage-line">{storageText}</div>
      </footer>
    </aside>
  );
}
