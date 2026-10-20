import { FormEvent, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { Settings } from '../api/types';
import { ErrorNotice, Hint, Loading } from '../components/Feedback';
import { FormField } from '../components/FormField';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { useAsync } from '../hooks/useAsync';

type SettingKey = keyof Settings;

/** Inputs hold text so a field can be cleared while typing; the browser enforces the bounds on submit. */
type Draft = Record<SettingKey, string>;

interface NumberSetting {
  key: SettingKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  unit?: string;
}

interface SettingsSection {
  title: string;
  fields: readonly NumberSetting[];
}

// Bounds mirror the engine's settings schema. A new section is one more entry here.
const SECTIONS: readonly SettingsSection[] = [
  {
    title: 'Jobs',
    fields: [
      {
        key: 'defaultBatchSize',
        label: 'Default batch size',
        hint: 'Rows read and written per batch for new jobs. Existing jobs keep their own.',
        min: 1,
        max: 10_000,
      },
    ],
  },
  {
    title: 'CSV files',
    fields: [
      {
        key: 'csvMaxUploadMb',
        label: 'Upload size limit',
        hint: 'Largest CSV file accepted on upload. A CSV used as a lookup is held in memory and needs roughly 5× its size, so keep this within what this machine can spare.',
        min: 1,
        max: 512,
        unit: 'MB',
      },
    ],
  },
  {
    title: 'HTTP API',
    fields: [
      {
        key: 'httpMaxResponseMb',
        label: 'Response size limit',
        hint: 'Largest response read from an HTTP API, per page. A lookup on an endpoint holds all its pages in memory, so keep this within what this machine can spare.',
        min: 1,
        max: 512,
        unit: 'MB',
      },
    ],
  },
];

const KEYS = SECTIONS.flatMap((section) => section.fields.map((field) => field.key));

// Built from SECTIONS, so a new setting needs no change here.
function toDraft(settings: Settings): Draft {
  const draft = {} as Draft;
  for (const key of KEYS) draft[key] = String(settings[key]);
  return draft;
}

function toSettings(draft: Draft): Settings {
  const settings = {} as Record<SettingKey, number>;
  for (const key of KEYS) settings[key] = Number(draft[key]);
  return settings;
}

function withUnit(value: number, unit?: string): string {
  const number = value.toLocaleString();
  return unit ? `${number} ${unit}` : number;
}

export function SettingsPage() {
  const view = useAsync(() => api.settings.get(), []);
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>();

  // Loading and saving both replace the view; the form then shows what the engine stored.
  useEffect(() => {
    if (view.data) setDraft(toDraft(view.data.settings));
  }, [view.data]);

  // Saving over a settings file that no longer parses repairs it; the engine reports such a file as a conflict.
  const resetSavedSettings = async () => {
    setBusy(true);
    setError(undefined);
    try {
      view.setData(await api.settings.reset());
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  if (view.error instanceof ApiError && view.error.status === 409) {
    return (
      <>
        <ErrorNotice error={view.error} />
        <ErrorNotice error={error} />
        <button type="button" className="btn btn-quiet" onClick={resetSavedSettings} disabled={busy}>
          Reset to defaults
        </button>
      </>
    );
  }
  if (view.error) return <ErrorNotice error={view.error} />;
  if (!view.data || !draft) return <Loading />;

  const { settings, defaults } = view.data;
  const dirty = KEYS.some((key) => Number(draft[key]) !== settings[key]);

  const edit = (key: SettingKey, value: string) => {
    setDraft({ ...draft, [key]: value });
    setSaved(false);
  };

  const resetToDefaults = () => {
    setDraft(toDraft(defaults));
    setSaved(false);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      view.setData(await api.settings.update(toSettings(draft)));
      setSaved(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" description="Defaults for this machine. Saved in the workspace, not shared through git." />
      <form className="editor settings-form" onSubmit={save}>
        {SECTIONS.map((section) => (
          <section key={section.title} className="stage" aria-label={section.title}>
            <h2>{section.title}</h2>
            <div className="form-grid">
              {section.fields.map((field) => (
                <FormField
                  key={field.key}
                  label={field.label}
                  hint={
                    Number(draft[field.key]) === defaults[field.key]
                      ? field.hint
                      : `${field.hint} Default: ${withUnit(defaults[field.key], field.unit)}.`
                  }
                >
                  {(props) => (
                    <div className="input-with-unit">
                      <input
                        {...props}
                        type="number"
                        inputMode="numeric"
                        min={field.min}
                        max={field.max}
                        step={1}
                        required
                        value={draft[field.key]}
                        onChange={(event) => edit(field.key, event.target.value)}
                      />
                      {field.unit && <span>{field.unit}</span>}
                    </div>
                  )}
                </FormField>
              ))}
            </div>
          </section>
        ))}

        <div className="action-bar">
          <ErrorNotice error={error} />
          <div role="status">{saved && !dirty && <Hint tone="ok">Settings saved.</Hint>}</div>
          <div className="action-bar-buttons">
            <button type="button" className="btn btn-quiet" onClick={resetToDefaults} disabled={busy}>
              Reset to defaults
            </button>
            <button type="submit" className="btn btn-primary" disabled={!dirty || busy}>
              <Icon name="check" /> {busy ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
