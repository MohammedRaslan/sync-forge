import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Connection, FieldInfo, FieldMapping, JobInput, Lookup, PreviewResult, SourceFilter, SourcePreview } from '../api/types';
import { Conduit } from '../components/Conduit';
import { ErrorNotice, Hint, Loading } from '../components/Feedback';
import { FormField } from '../components/FormField';
import { Icon } from '../components/Icon';
import { useAsync } from '../hooks/useAsync';
import { uploadCsvFileAsNamed } from '../lib/csvUpload';
import { KIND_LABEL } from '../lib/format';
import { CollectionPicker } from './editor/CollectionPicker';
import { LookupEditor } from './editor/LookupEditor';
import { MappingTable } from './editor/MappingTable';
import { PreviewTable } from './editor/PreviewTable';
import { SourceFieldList } from './editor/SourceFieldList';
import { SourceFilters } from './editor/SourceFilters';
import { SourceRowsTable, StatementView } from './editor/SourcePreview';

const EMPTY_JOB: JobInput = {
  name: '',
  source: { connectionId: '', collection: '' },
  target: { connectionId: '', collection: '', keyFields: [] },
  mappings: [],
  mode: 'full',
  batchSize: 500,
  errorPolicy: 'fail',
};

/** Types that cannot sensibly order rows, so they are not offered as watermarks. */
const NOT_ORDERABLE = new Set(['object', 'array', 'json', 'jsonb', 'binary', 'null']);

const MAX_LOOKUPS = 5;

/** Relational databases: they take SQL query sources, and their columns have plain names. */
const SQL_KINDS: ReadonlySet<Connection['kind'] | undefined> = new Set(['postgres', 'mysql']);

type PreviewTab = 'mapped' | 'source' | 'query';
const PREVIEW_TABS: Array<[PreviewTab, string]> = [
  ['mapped', 'Mapped rows'],
  ['source', 'Source rows'],
  ['query', 'Query'],
];

/** Each tab holds its own result or error: the source can be previewed before the job is complete. */
interface PreviewState {
  mapped?: PreviewResult;
  mappedError?: unknown;
  source?: SourcePreview;
  sourceError?: unknown;
}

/** What the source preview needs from a draft; mappings and lookups that are not filled in yet are left out. */
function sourcePreviewInput(job: JobInput) {
  const { source, mode, watermarkField } = job;
  const lookups = job.lookups?.filter(
    (lookup) => lookup.connectionId && lookup.collection && lookup.on.every((pair) => pair.source.trim() && pair.lookup.trim()),
  );
  return { source, lookups, mode, watermarkField, mappings: job.mappings.filter((mapping) => mapping.to.trim() !== '') };
}

/** Job names are limited to 80 characters (job.model.ts). */
const MAX_NAME_LENGTH = 80;
const COPY_SUFFIX = ' (copy)';

/** Name for a duplicated job: the original name plus " (copy)", shortened so the result stays within the limit. */
function copyName(name: string): string {
  return `${name.slice(0, MAX_NAME_LENGTH - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
}

function isUnder(path: string, name: string): boolean {
  return path === name || path.startsWith(`${name}.`);
}

const TARGET_HINTS = {
  postgres: 'Key columns need a primary key or unique constraint in the target table. Unmapped columns keep their values.',
  mysql:
    'Rows are matched on the key fields only. A clash on any other unique column fails the row instead of updating a different one. Unmapped columns keep their values.',
  mongo: 'Documents are matched on the key fields. Only mapped fields are updated; dotted names such as address.city write nested fields.',
  cosmos: 'Map a field to “id” and make it the only key. Writes replace whole documents, so map every field the document needs.',
} as const satisfies Record<Exclude<Connection['kind'], 'csv'>, string>;

/** Targets that keep value types, so text read from a CSV file stays text unless a transform converts it. */
const TYPED_DOCUMENT_KINDS: ReadonlySet<Connection['kind'] | undefined> = new Set(['mongo', 'cosmos']);

/** Loads the field list of a collection; a collection that does not exist yet simply has no fields. */
function useFields(connectionId: string, collection: string) {
  return useAsync<FieldInfo[]>(
    () => (connectionId && collection ? api.connections.fields(connectionId, collection) : Promise.resolve([])),
    [connectionId, collection],
  );
}

function suggestTargetName(sourcePath: string, targetFields: FieldInfo[], targetKind?: Connection['kind']): string {
  const lastSegment = sourcePath.split('.').pop() ?? sourcePath;
  const match = targetFields.find((field) => [sourcePath, lastSegment].some((name) => name.toLowerCase() === field.path.toLowerCase()));
  if (match) return match.path;
  return SQL_KINDS.has(targetKind) ? sourcePath.replace(/\./g, '_') : sourcePath;
}

export function JobEditorPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  // `/jobs/new?from=<id>` opens a copy of that job; saving creates a new job.
  const copyOf = id ? undefined : searchParams.get('from') ?? undefined;
  const loadId = id ?? copyOf;
  const navigate = useNavigate();
  const [draft, setDraft] = useState<JobInput>(EMPTY_JOB);
  const [preview, setPreview] = useState<PreviewState>();
  const [previewTab, setPreviewTab] = useState<PreviewTab>('mapped');
  const [busy, setBusy] = useState<'preview' | 'source-preview' | 'save'>();
  const [error, setError] = useState<unknown>();
  // The SQL whose columns are shown. Columns are read on request, not on every keystroke.
  const [describedQuery, setDescribedQuery] = useState<string>();

  const setup = useAsync(async () => {
    const [connections, transforms, job, settingsView] = await Promise.all([
      api.connections.list(),
      api.transforms.list(),
      loadId ? api.jobs.get(loadId) : Promise.resolve(undefined),
      // Only a new job takes the machine's default batch size; edits and copies keep their own.
      loadId ? Promise.resolve(undefined) : api.settings.get(),
    ]);
    return { connections, transforms, job, settings: settingsView?.settings };
  }, [loadId]);

  useEffect(() => {
    if (setup.data?.job) {
      const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = setup.data.job;
      setDraft(copyOf ? { ...input, name: copyName(input.name) } : input);
      setDescribedQuery(input.source.query);
    }
  }, [setup.data?.job, copyOf]);

  // The form renders only after setup, so this runs before the user can edit anything.
  const defaultBatchSize = setup.data?.settings?.defaultBatchSize;
  useEffect(() => {
    if (defaultBatchSize !== undefined) setDraft((job) => ({ ...job, batchSize: defaultBatchSize }));
  }, [defaultBatchSize]);

  const connections = useMemo(() => new Map(setup.data?.connections.map((c) => [c.id, c]) ?? []), [setup.data]);
  const sourceConnection = connections.get(draft.source.connectionId);
  const targetConnection = connections.get(draft.target.connectionId);
  const isQuerySource = draft.source.query !== undefined;
  // CSV files are read whole: no SQL query, no watermark (the engine refuses both).
  const sourceIsCsv = sourceConnection?.kind === 'csv';
  const tableFields = useFields(draft.source.connectionId, isQuerySource ? '' : draft.source.collection);
  const queryFields = useAsync<FieldInfo[]>(
    () =>
      isQuerySource && draft.source.connectionId && describedQuery
        ? api.connections.queryFields(draft.source.connectionId, describedQuery)
        : Promise.resolve([]),
    [isQuerySource, draft.source.connectionId, describedQuery],
  );
  const sourceFields = isQuerySource ? queryFields : tableFields;
  const sourceChosen = isQuerySource ? Boolean(describedQuery) : Boolean(draft.source.collection);
  const targetFields = useFields(draft.target.connectionId, draft.target.collection);

  const lookups = draft.lookups ?? [];
  const lookupSources = JSON.stringify(lookups.map((lookup) => [lookup.connectionId, lookup.collection]));
  const lookupFields = useAsync<FieldInfo[][]>(
    () =>
      Promise.all(
        lookups.map((lookup) =>
          lookup.connectionId && lookup.collection
            ? api.connections.fields(lookup.connectionId, lookup.collection).catch(() => [])
            : Promise.resolve([]),
        ),
      ),
    [lookupSources],
  );
  const lookupFieldPaths = lookups.flatMap((lookup, index) =>
    (lookupFields.data?.[index] ?? []).map((field) => `${lookup.as}.${field.path}`),
  );

  // A source field counts as selected when any mapping reads it, whatever its transform.
  const selectedSourceFields = useMemo(
    () => new Set(draft.mappings.flatMap((m) => (m.from ? [m.from] : []))),
    [draft.mappings],
  );

  const change = (update: (job: JobInput) => JobInput) => {
    setDraft(update);
    setPreview(undefined);
  };

  const addMappingFor = (job: JobInput, field: FieldInfo): JobInput => {
    const to = suggestTargetName(field.path, targetFields.data ?? [], targetConnection?.kind);
    if (job.mappings.some((mapping) => mapping.to === to)) return job;
    const targetKey = targetFields.data?.find((f) => f.path === to)?.primaryKey;
    const makeKey = job.target.keyFields.length === 0 && (field.primaryKey || targetKey);
    return {
      ...job,
      mappings: [...job.mappings, { from: field.path, to, transform: 'none' }],
      target: { ...job.target, keyFields: makeKey ? [to] : job.target.keyFields },
    };
  };

  const removeMappingsFrom = (job: JobInput, paths: ReadonlySet<string>): JobInput => {
    const removed = job.mappings.filter((m) => m.from && paths.has(m.from)).map((m) => m.to);
    return {
      ...job,
      mappings: job.mappings.filter((m) => !removed.includes(m.to)),
      target: { ...job.target, keyFields: job.target.keyFields.filter((key) => !removed.includes(key)) },
    };
  };

  const toggleSourceField = (field: FieldInfo) =>
    change((job) => (selectedSourceFields.has(field.path) ? removeMappingsFrom(job, new Set([field.path])) : addMappingFor(job, field)));

  const selectAll = (fields: FieldInfo[], select: boolean) =>
    change((job) => {
      if (!select) return removeMappingsFrom(job, new Set(fields.map((f) => f.path)));
      return fields.filter((f) => !selectedSourceFields.has(f.path)).reduce(addMappingFor, job);
    });

  const changeMapping = (index: number, mapping: FieldMapping | undefined) =>
    change((job) => {
      const previous = job.mappings[index];
      const mappings = mapping ? job.mappings.map((m, i) => (i === index ? mapping : m)) : job.mappings.filter((_, i) => i !== index);
      // Keep key fields pointing at the right target name when it is renamed or removed.
      const keyFields = job.target.keyFields
        .map((key) => (key === previous.to ? mapping?.to : key))
        .filter((key): key is string => Boolean(key));
      return { ...job, mappings, target: { ...job.target, keyFields } };
    });

  const toggleKey = (field: string) =>
    change((job) => {
      const keys = job.target.keyFields;
      return { ...job, target: { ...job.target, keyFields: keys.includes(field) ? keys.filter((k) => k !== field) : [...keys, field] } };
    });

  const setSourceMode = (query: boolean) =>
    change((job) => ({ ...job, source: { connectionId: job.source.connectionId, collection: '', query: query ? '' : undefined } }));

  const withLookups = (job: JobInput, next: Lookup[]): JobInput => ({ ...job, lookups: next.length > 0 ? next : undefined });

  const addLookup = () =>
    change((job) => {
      const current = job.lookups ?? [];
      // Related tables usually live next to the source, so start from the source connection.
      const lookup: Lookup = {
        as: `lookup${current.length + 1}`,
        connectionId: job.source.connectionId,
        collection: '',
        on: [{ source: '', lookup: '' }],
        required: false,
      };
      return withLookups(job, [...current, lookup]);
    });

  const changeLookup = (index: number, lookup: Lookup) =>
    change((job) => {
      const current = job.lookups ?? [];
      const previous = current[index].as;
      // Renaming a lookup renames the paths that read it, in mappings and in later lookups.
      const rename = (path: string) =>
        previous && lookup.as && previous !== lookup.as && isUnder(path, previous) ? lookup.as + path.slice(previous.length) : path;
      const next = current.map((other, i) =>
        i === index ? lookup : { ...other, on: other.on.map((pair) => ({ ...pair, source: rename(pair.source) })) },
      );
      return { ...withLookups(job, next), mappings: job.mappings.map((m) => (m.from ? { ...m, from: rename(m.from) } : m)) };
    });

  const removeLookup = (index: number) =>
    change((job) => {
      const current = job.lookups ?? [];
      const name = current[index].as;
      const reading = new Set(job.mappings.flatMap((m) => (m.from && isUnder(m.from, name) ? [m.from] : [])));
      return withLookups(removeMappingsFrom(job, reading), current.filter((_, i) => i !== index));
    });

  const setFilters = (filters: SourceFilter[]) =>
    change((job) => ({ ...job, source: { ...job.source, filters: filters.length > 0 ? filters : undefined } }));

  /** Mapped rows and source rows together; each tab shows its own error. */
  const runPreview = async () => {
    setBusy('preview');
    setError(undefined);
    const [mapped, source] = await Promise.allSettled([api.jobs.preview(draft), api.jobs.sourcePreview(sourcePreviewInput(draft))]);
    setPreview({
      mapped: mapped.status === 'fulfilled' ? mapped.value : undefined,
      mappedError: mapped.status === 'rejected' ? mapped.reason : undefined,
      source: source.status === 'fulfilled' ? source.value : undefined,
      sourceError: source.status === 'rejected' ? source.reason : undefined,
    });
    setPreviewTab(mapped.status === 'fulfilled' || source.status === 'rejected' ? 'mapped' : 'source');
    setBusy(undefined);
  };

  const runSourcePreview = async () => {
    setBusy('source-preview');
    setError(undefined);
    try {
      setPreview({ source: await api.jobs.sourcePreview(sourcePreviewInput(draft)) });
    } catch (caught) {
      setPreview({ sourceError: caught });
    }
    setPreviewTab('source');
    setBusy(undefined);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('save');
    setError(undefined);
    try {
      const saved = id ? await api.jobs.update(id, draft) : await api.jobs.create(draft);
      navigate(`/jobs/${saved.id}`);
    } catch (caught) {
      setError(caught);
      setBusy(undefined);
    }
  };

  if (setup.error) return <ErrorNotice error={setup.error} />;
  if (!setup.data) return <Loading />;

  const sortedConnections = setup.data.connections;
  const targetConnections = sortedConnections.filter((c) => c.kind !== 'csv');
  const watermarkCandidates = (sourceFields.data ?? []).filter((field) => !NOT_ORDERABLE.has(field.type));

  return (
    <form className="editor" onSubmit={save}>
      <header className="editor-header">
        <Link to={loadId ? `/jobs/${loadId}` : '/'} className="back-link">
          {loadId ? 'Back to job' : 'Back to jobs'}
        </Link>
        <input
          className="title-input"
          aria-label="Job name"
          placeholder="Name this job, e.g. Orders to new core"
          value={draft.name}
          onChange={(event) => change((job) => ({ ...job, name: event.target.value }))}
          required
          maxLength={80}
        />
        <Conduit
          source={{ collection: draft.source.collection, connection: sourceConnection?.name, kind: sourceConnection?.kind }}
          target={{ collection: draft.target.collection, connection: targetConnection?.name, kind: targetConnection?.kind }}
        />
      </header>

      <section className="stage" aria-labelledby="stage-source">
        <h2 id="stage-source">
          <span className="stage-number">1</span> Choose the source
        </h2>
        <div className="stage-body">
          <FormField label="Source connection">
            {(props) => (
              <select
                {...props}
                value={draft.source.connectionId}
                onChange={(event) => {
                  const connectionId = event.target.value;
                  const toCsv = connections.get(connectionId)?.kind === 'csv';
                  change((job) => ({
                    ...job,
                    source: { connectionId, collection: '' },
                    mode: toCsv ? 'full' : job.mode,
                    watermarkField: toCsv ? undefined : job.watermarkField,
                  }));
                }}
              >
                <option value="">Choose a connection</option>
                {sortedConnections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({KIND_LABEL[c.kind]})
                  </option>
                ))}
              </select>
            )}
          </FormField>
          {SQL_KINDS.has(sourceConnection?.kind) && (
            <fieldset className="segmented" aria-label="Read from">
              {[false, true].map((query) => (
                <label key={String(query)} className={isQuerySource === query ? 'is-selected' : undefined}>
                  <input type="radio" name="source-mode" checked={isQuerySource === query} onChange={() => setSourceMode(query)} />
                  {query ? 'SQL query' : 'Table or view'}
                </label>
              ))}
            </fieldset>
          )}
          {isQuerySource ? (
            <div className="form-grid">
              <FormField label="Query name" hint="Shown for this source in jobs and runs, like the name of a view.">
                {(props) => (
                  <input
                    {...props}
                    className="mono"
                    placeholder="orders_with_customers"
                    value={draft.source.collection}
                    onChange={(event) => change((job) => ({ ...job, source: { ...job.source, collection: event.target.value } }))}
                    spellCheck={false}
                    required
                  />
                )}
              </FormField>
              <FormField
                label="SQL query"
                wide
                hint="One SELECT, run in a read-only transaction. Field selection and the watermark are applied around it, so leave out ORDER BY and LIMIT."
              >
                {(props) => (
                  <textarea
                    {...props}
                    className="mono query-input"
                    rows={7}
                    placeholder={'SELECT o.*, c.email\nFROM public.orders o\nJOIN public.customers c ON c.id = o.customer_id'}
                    value={draft.source.query ?? ''}
                    onChange={(event) => change((job) => ({ ...job, source: { ...job.source, query: event.target.value } }))}
                    spellCheck={false}
                  />
                )}
              </FormField>
              <div className="query-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={!draft.source.query?.trim() || queryFields.loading}
                  onClick={() => setDescribedQuery(draft.source.query?.trim())}
                >
                  <Icon name="eye" /> {queryFields.loading ? 'Reading columns…' : 'Read columns'}
                </button>
                {describedQuery && describedQuery !== draft.source.query?.trim() && (
                  <span className="field-hint">The query changed since its columns were read.</span>
                )}
              </div>
            </div>
          ) : (
            <CollectionPicker
              key={draft.source.connectionId}
              label={sourceIsCsv ? 'File' : 'Table or collection'}
              connectionId={draft.source.connectionId}
              onUpload={
                sourceIsCsv ? (file, onProgress) => uploadCsvFileAsNamed(draft.source.connectionId, file, onProgress) : undefined
              }
              value={draft.source.collection}
              onChange={(collection) => change((job) => ({ ...job, source: { ...job.source, collection } }))}
            />
          )}
          {sourceFields.loading && sourceChosen && <Loading label="Reading fields" />}
          {sourceFields.error && sourceChosen && <Hint tone="warn">{sourceFields.error.message}</Hint>}
          <SourceFieldList
            fields={sourceFields.data ?? []}
            selected={selectedSourceFields}
            onToggle={toggleSourceField}
            onSelectAll={(select) => selectAll(sourceFields.data ?? [], select)}
          />
          {draft.source.connectionId && (
            <SourceFilters filters={draft.source.filters ?? []} fields={sourceFields.data ?? []} onChange={setFilters} />
          )}
          {sourceChosen && (
            <div>
              <button type="button" className="btn" onClick={runSourcePreview} disabled={busy !== undefined}>
                <Icon name="eye" /> {busy === 'source-preview' ? 'Reading rows…' : 'Preview source rows'}
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="stage" aria-labelledby="stage-lookups">
        <h2 id="stage-lookups">
          <span className="stage-number">2</span> Add related data <span className="stage-optional">optional</span>
        </h2>
        <div className="stage-body">
          {lookups.length === 0 && (
            <Hint>
              Need a value from another table, such as the customer’s email for each order? Add a lookup. It finds the
              matching row by key, in this or any other connection, and makes its fields available to map.
            </Hint>
          )}
          {lookups.map((lookup, index) => (
            <LookupEditor
              key={index}
              index={index}
              lookup={lookup}
              connections={sortedConnections}
              fields={lookupFields.data?.[index] ?? []}
              selected={selectedSourceFields}
              onChange={(next) => changeLookup(index, next)}
              onRemove={() => removeLookup(index)}
              onToggleField={toggleSourceField}
              onSelectAll={selectAll}
            />
          ))}
          <button type="button" className="btn btn-quiet" onClick={addLookup} disabled={lookups.length >= MAX_LOOKUPS}>
            <Icon name="plus" /> Add a lookup
          </button>
          {lookups.length > 0 && draft.mode === 'incremental' && (
            <Hint tone="warn">
              Incremental runs only notice changes in the source. When a looked-up row changes, reset the watermark (Start
              over) to bring the target up to date.
            </Hint>
          )}
        </div>
      </section>

      <section className="stage" aria-labelledby="stage-target">
        <h2 id="stage-target">
          <span className="stage-number">3</span> Choose the target
        </h2>
        <div className="stage-body">
          <FormField label="Target connection">
            {(props) => (
              <select
                {...props}
                value={draft.target.connectionId}
                onChange={(event) =>
                  change((job) => ({ ...job, target: { ...job.target, connectionId: event.target.value, collection: '' } }))
                }
              >
                <option value="">Choose a connection</option>
                {targetConnections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({KIND_LABEL[c.kind]})
                  </option>
                ))}
              </select>
            )}
          </FormField>
          {targetConnections.length === 0 && sortedConnections.length > 0 && (
            <Hint>CSV connections can be a source or a lookup, not a target. Add a database connection to write to.</Hint>
          )}
          <CollectionPicker
            label="Table or collection"
            allowNew
            connectionId={draft.target.connectionId}
            value={draft.target.collection}
            onChange={(collection) => change((job) => ({ ...job, target: { ...job.target, collection } }))}
          />
          {targetConnection && targetConnection.kind !== 'csv' && <Hint>{TARGET_HINTS[targetConnection.kind]}</Hint>}
        </div>
      </section>

      <section className="stage" aria-labelledby="stage-mapping">
        <h2 id="stage-mapping">
          <span className="stage-number">4</span> Map fields
        </h2>
        <div className="stage-body">
          {draft.mappings.length === 0 && <Hint>Select source fields above, or add a computed field.</Hint>}
          <MappingTable
            mappings={draft.mappings}
            keyFields={draft.target.keyFields}
            transforms={setup.data.transforms}
            onChange={changeMapping}
            onToggleKey={toggleKey}
            onAdd={() => change((job) => ({ ...job, mappings: [...job.mappings, { to: '', transform: 'expression', argument: '' }] }))}
          />
          {sourceIsCsv && TYPED_DOCUMENT_KINDS.has(targetConnection?.kind) && (
            <Hint>CSV values are text. Pick a transform (number, boolean, date) for fields that should not stay text.</Hint>
          )}
          {draft.mappings.length > 0 && draft.target.keyFields.length === 0 && (
            <Hint tone="warn">Mark at least one target field as the key, so re-runs update rows instead of duplicating them.</Hint>
          )}
          <datalist id="source-field-options">
            {sourceFields.data?.map((field) => <option key={field.path} value={field.path} />)}
            {lookupFieldPaths.map((path) => <option key={path} value={path} />)}
          </datalist>
          <datalist id="target-field-options">
            {targetFields.data?.map((field) => <option key={field.path} value={field.path} />)}
          </datalist>
        </div>
      </section>

      <section className="stage" aria-labelledby="stage-run">
        <h2 id="stage-run">
          <span className="stage-number">5</span> Decide how it runs
        </h2>
        <div className="stage-body">
          <fieldset className="segmented" aria-label="Run mode">
            {(['full', 'incremental'] as const).map((mode) => (
              <label key={mode} className={draft.mode === mode ? 'is-selected' : undefined}>
                <input
                  type="radio"
                  name="mode"
                  checked={draft.mode === mode}
                  disabled={sourceIsCsv && mode === 'incremental'}
                  onChange={() => change((job) => ({ ...job, mode }))}
                />
                {mode === 'full' ? 'Full copy every run' : 'Only new and changed rows'}
              </label>
            ))}
          </fieldset>
          {sourceIsCsv && <Hint>CSV files run in full mode: each upload replaces the file, and re-running is safe.</Hint>}
          <div className="form-grid">
            {draft.mode === 'incremental' && (
              <FormField label="Watermark field" hint="A field that grows when a row changes, such as updated_at. Each run continues from the last value it saw.">
                {(props) => (
                  <select
                    {...props}
                    value={draft.watermarkField ?? ''}
                    onChange={(event) => change((job) => ({ ...job, watermarkField: event.target.value || undefined }))}
                  >
                    <option value="">Choose a field</option>
                    {watermarkCandidates.map((field) => (
                      <option key={field.path} value={field.path}>
                        {field.path}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
            )}
            <FormField label="Batch size" hint="Rows read and written per round trip.">
              {(props) => (
                <input
                  {...props}
                  type="number"
                  min={1}
                  max={10000}
                  value={draft.batchSize}
                  onChange={(event) => change((job) => ({ ...job, batchSize: Number(event.target.value) }))}
                />
              )}
            </FormField>
            <FormField
              label="When a row fails"
              hint={
                draft.errorPolicy === 'skip'
                  ? 'Rows that fail to map or write are set aside; failed writes get one more try at the end. The run lists the rows it could not sync, with the reason.'
                  : 'The run stops at the first row that cannot be mapped or written.'
              }
            >
              {(props) => (
                <select
                  {...props}
                  value={draft.errorPolicy}
                  onChange={(event) => change((job) => ({ ...job, errorPolicy: event.target.value as JobInput['errorPolicy'] }))}
                >
                  <option value="fail">Stop the run</option>
                  <option value="skip">Skip, retry, and list it</option>
                </select>
              )}
            </FormField>
            <FormField label="Notes" wide hint="Optional. Why this job exists, who owns it.">
              {(props) => (
                <textarea
                  {...props}
                  rows={2}
                  value={draft.description ?? ''}
                  onChange={(event) => change((job) => ({ ...job, description: event.target.value || undefined }))}
                />
              )}
            </FormField>
          </div>
        </div>
      </section>

      {preview && (
        <section className="stage" aria-labelledby="stage-preview">
          <h2 id="stage-preview">Preview</h2>
          <fieldset className="segmented" aria-label="Preview view">
            {PREVIEW_TABS.map(([tab, label]) => (
              <label key={tab} className={previewTab === tab ? 'is-selected' : undefined}>
                <input type="radio" name="preview-tab" checked={previewTab === tab} onChange={() => setPreviewTab(tab)} />
                {label}
              </label>
            ))}
          </fieldset>
          {previewTab === 'mapped' &&
            (preview.mappedError ? (
              <ErrorNotice error={preview.mappedError} />
            ) : preview.mapped ? (
              <PreviewTable preview={preview.mapped} />
            ) : (
              <Hint>Use “Preview 10 rows” to see rows as they would be written. It needs a target and mappings.</Hint>
            ))}
          {previewTab !== 'mapped' && preview.sourceError !== undefined && <ErrorNotice error={preview.sourceError} />}
          {previewTab === 'source' && preview.source && <SourceRowsTable rows={preview.source.rows} />}
          {previewTab === 'query' && preview.source && (
            <StatementView
              preview={preview.source}
              incremental={draft.mode === 'incremental'}
              write={{
                target: `${targetConnection?.name ?? 'target'} / ${draft.target.collection || '…'}`,
                statement: preview.mapped?.writeStatement,
                error: preview.mappedError,
              }}
            />
          )}
        </section>
      )}

      <div className="action-bar">
        <ErrorNotice error={error} />
        <div className="action-bar-buttons">
          <button type="button" className="btn" onClick={runPreview} disabled={busy !== undefined}>
            <Icon name="eye" /> {busy === 'preview' ? 'Reading rows…' : 'Preview 10 rows'}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy !== undefined}>
            <Icon name="check" /> {busy === 'save' ? 'Saving…' : id ? 'Save changes' : 'Save job'}
          </button>
        </div>
      </div>
    </form>
  );
}
