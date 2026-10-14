# Architecture

Syncforge is two TypeScript applications in one repository:

- **engine/**: a NestJS service that holds connections and jobs, talks to the databases, and executes runs.
- **ui/**: a React single-page app (Vite) that only talks to the engine's HTTP API.

In production one Docker image runs the engine, which also serves the built UI, so the whole tool is one process on one port.

```mermaid
flowchart LR
  UI[React UI] -- JSON over HTTP /api --> API[Controllers]
  API --> CS[ConnectionsService]
  API --> JS[JobsService]
  API --> SS[SyncService]
  API --> RS[RunsService]
  RS --> RUN[SyncRunner]
  SS --> MAP[RowMapper]
  MAP --> TR[TransformRegistry]
  CS --> CF[ConnectorFactory]
  CF --> PG[PostgresConnector]
  CF --> MY[MysqlConnector]
  CF --> MG[MongoConnector]
  CF --> CO[CosmosConnector]
  CS & JS & RS --> FS[(workspace/ JSON files)]
```

## Engine modules

| Module | Responsibility |
| --- | --- |
| `core.module.ts` | Process-wide singletons: configuration, workspace, encryption, transform registry, connector factory. |
| `connections/` | CRUD for saved connections, encryption of their settings, connection tests, schema browsing. |
| `connectors/` | One class per database engine behind a common `Connector` interface. Pure SQL builders live next to the Postgres connector. |
| `transforms/` | The registry of field transforms. |
| `jobs/` | Job specs (validation, CRUD), incremental state (watermarks), and `RunLocks`. |
| `sync/` | Everything about executing a job: `RowMapper`, `SyncRunner`, `SyncService` (preview, reconciliation), `ReconcilesService` (keeps the latest reconcile's counts), `RunsService` (background runs and history). |
| `storage/` | `JsonDirectoryStore` (one entity per JSON file, atomic writes), `SecretBox` (AES-256-GCM), `Workspace` (folder layout). |
| `common/` | Errors and their HTTP mapping, zod validation pipe, value normalization and comparison, path helpers. |

Dependencies point one way: `sync` → `jobs` → `connections` → `connectors`. `RunLocks` lives in `jobs` so that deleting a running job can be refused without `jobs` knowing about the runner.

## Life of a run

1. `POST /api/jobs/:id/runs` reaches `RunsService.start`. It takes the job's lock (a second start gets `409`), reads the stored watermark for incremental jobs, saves a run record and returns `202` immediately.
2. In the background, `SyncService.withPipeline` compiles the mappings into a `RowMapper` first, so a broken expression fails before any database is opened. It then opens the source, target and lookup connectors and checks rules that depend on which databases are involved (for example, Cosmos DB targets must be keyed on `id`).
3. `SyncRunner.run` loops:
   1. Read a batch from the source. Postgres uses a server-side cursor, MongoDB a cursor, Cosmos DB continuation pages, so memory use is bounded by the batch size. The job's conditions (`source.filters`) are part of the database query, combined with the watermark, so rows outside them are never read. Each connector builds that query in one function used by both `readBatches` and `explainRead`, so the previewed statement is the executed one.
   2. Apply the job's lookups (`LookupEnricher`): for each lookup, collect the batch's distinct match keys, fetch the matching rows with one `findByKeys` call (chunked for large batches), and attach each match to its row under the lookup name.
   3. Map each row and check that key fields are not empty. Depending on the job's error policy, a failing row stops the run or is skipped and reported (`RunHooks.onRowFailed`).
   4. De-duplicate the batch by key (last row wins).
   5. Upsert the batch into the target. With the skip policy, a failed batch is written again one row at a time, so only the refused rows are set aside; this is safe because upserts are idempotent. Set-aside rows get one more try after the last batch, and those that still fail are reported with their values and the database's reason. The run record keeps the first 500.
   6. Report progress and the new checkpoint. `RunsService` persists the watermark immediately and flushes the run record to disk at most once a second.
4. Cancelling aborts an `AbortSignal` that both the runner and the connectors check between batches. Rows already written stay written.
5. The run ends as `succeeded`, `failed` or `cancelled`, the lock is released, and history is pruned to the newest 30 runs per job. Runs still marked `running` when the engine starts (after a crash) are marked `failed`.

## Guarantees and their reasons

**Idempotent writes.** Every connector's `upsert` matches on the job's key fields. Running a job twice leaves the target unchanged, which is what makes retries, resumed runs and `>=` watermarks safe.

**No lost rows on incremental runs.** Rows are read in watermark order, and the checkpoint is the watermark of the last row read, taken from the database's own ordering rather than recomputed in JavaScript, so collation differences cannot skip text watermarks. The next run starts at `>=` that value, so rows sharing the boundary value are re-read rather than missed.

**Atomic batches in PostgreSQL.** Each batch is written in one transaction. Large batches are split into several statements to stay below the 65,535 bind parameter limit.

**Values survive the trip.** Drivers return their own types (BSON `ObjectId`, `Decimal128`, `bigint` as strings, `Buffer`). `normalizeValue` converts them to portable values before they cross into a different database or into JSON. MongoDB-to-MongoDB jobs keep BSON types because the Mongo connector writes values as they come.

**Representation-tolerant verification.** Reconciliation compares with `valuesEqual`, which treats `12.5` and `"12.50"`, a `Date` and its ISO string, and a JSON string and the parsed object as equal. Row identity uses `keyString`, which does the same for keys (`1` and `"1"`, an `ObjectId` and its hex).

**Latest reconcile kept as counts only.** After a successful reconcile, `ReconcilesService` saves a `ReconcileSummary` (counts and `checkedAt`) to `workspace/.local/reconciles/<jobId>.json`, replacing the previous one; a failed reconcile saves nothing. Missing keys and mismatched values are never stored, because they are customer data. Like run history, a summary is kept when its job is deleted.

## Security model

- The engine binds to `127.0.0.1` by default. The Docker image binds to `0.0.0.0` inside the container, and compose publishes the port on loopback only.
- Connection settings are encrypted with AES-256-GCM. Only a connection's name and type are stored in clear text. The API never returns the secret field (`password`, `uri` or `key`).
- SQL identifiers are always quoted and values always bound as parameters. Field paths are validated so they cannot contain `$` (MongoDB operators) or `__proto__`-style segments.
- SQL query sources run in a read-only transaction, so a query (or a function it calls) cannot modify the source database. Like expressions, they run with the connection's privileges, which is why the connection's user should only be able to read what the job needs.
- Expression transforms run in a `node:vm` context with a per-row timeout. That isolates globals and stops runaway loops, but it is **not** a security boundary. Whoever can edit a job can run code on the host. This is acceptable for a local tool used by the engineers who own the databases, and is one more reason the tool is not meant to be exposed on a network.

## Design choices

**Strategy and Factory for databases.** `Connector` is the strategy interface, composed of smaller interfaces (`SchemaReader`, `DataReader`, `KeyReader`, `DataWriter`) so consumers depend only on what they use: the runner needs a reader and a writer, lookups only a `KeyReader`.

**Dry run as a writer.** A dry run is the normal run loop with the target writer replaced by `DryRunWriter`, which implements `DataWriter` by looking rows up (`findByKeys`) and recording inserts, updates and field changes instead of writing. Batching, lookups, mapping, the error policy and cancellation therefore behave exactly as in a real run. `RunsService` keeps the report on the run record and never saves the watermark of a dry run.

**Standalone scripts reuse the pipeline.** `src/standalone.ts` (exported as `sync-forge-engine/standalone`) composes the same `SyncService`, `SyncRunner`, lookups, transforms and `DryRunWriter` without NestJS. `SyncService` depends only on `ConnectionOpener` (`open(id)`), so the app passes `ConnectionsService` and a script passes its own settings, with secrets from environment variables. `jobs/job-script.ts` generates the script; its watermark lives in a local state file instead of the workspace.

**Lookups instead of a join engine.** A lookup reuses `findByKeys`, which every connector already has for reconciliation, so joining across PostgreSQL, MySQL, MongoDB and Cosmos DB needed no new connector code and no staging database. The cost is that lookups are many-to-one and keyed: arbitrary joins inside one PostgreSQL or MySQL database go through a SQL query source instead, where the database does the work. Query sources are wrapped as subqueries rather than edited, so watermarks and projections apply without parsing SQL, and they run in a read-only transaction. `ConnectorFactory` is the single place that maps a connection type to a class.

**Strategy registry for transforms.** Each transform is a definition with a `compile(argument)` method that returns a per-row function. Arguments are validated and expressions compiled once per job, not once per row.

**Repository over plain JSON files.** `JsonDirectoryStore` writes one file per entity with an atomic rename. It avoids a database dependency in a tool whose job is talking to databases, keeps job specs diff-friendly for review in git, and keeps machine-local state (secrets, history, watermarks) in a separate git-ignored folder.

**Validation at the edge.** zod schemas define the API contract. Cross-field rules (incremental needs a watermark, key fields must be mapped, no duplicate targets) live in the schema. Rules that need to know the database types run when a job is opened (`assertCompatible`).

**Things deliberately left out.** No queue, no scheduler, no ORM, no shared types package between engine and UI. Each would add moving parts that a local tool for a handful of engineers does not need yet. UI types in `ui/src/api/types.ts` mirror the engine's and are kept in sync by hand.

## Extending

### Adding a database

1. Add a config schema to `connections/connection.model.ts`, include it in the discriminated union, and add its secret field to `SECRET_FIELD` and `SECRET_REQUIRED`.
2. Implement `Connector` in `connectors/<name>/<name>.connector.ts`. Reuse `inferSchema` if the store is schemaless, and `normalizeValue` for values written to it.
3. Add a case to `ConnectorFactory.create`. TypeScript's exhaustiveness check points at anything you missed.
4. Add the form fields in `ui/src/pages/ConnectionForm.tsx` and a label in `KIND_LABEL`.

### Adding a transform

Add a name to `TRANSFORM_NAMES` and a definition to `DEFINITIONS` in `transforms/transform.registry.ts`, with a test in `test/transforms.spec.ts`. The UI picks it up from `GET /api/transforms`.

## HTTP API

All routes are under `/api`. Errors are JSON with a `message` and, for validation errors, `issues: [{ path, message }]`.

| Method and path | Purpose |
| --- | --- |
| `GET /connections` · `POST /connections` | List and create connections. |
| `GET/PUT/DELETE /connections/:id` | Read, update (blank secret keeps the saved one), delete. |
| `POST /connections/test` | Test settings before saving. Pass `connectionId` to fall back to a saved secret. |
| `GET /connections/:id/collections` | Tables, views, collections or containers. |
| `GET /connections/:id/fields?collection=` | Field list (inferred for document stores). |
| `POST /connections/:id/query-fields` | Columns a SQL query returns (PostgreSQL and MySQL), without reading rows. |
| `GET /transforms` | Available transforms. |
| `GET /jobs` · `POST /jobs` | List and create jobs. |
| `GET/PUT/DELETE /jobs/:id` | Read, update, delete (refused while running). |
| `GET /jobs/:id/export` | `{ fileName, content }` of a runnable `<job>.sync.ts` (connection settings without secrets). |
| `POST /jobs/preview` | Map the first 10 rows of an unsaved job without writing; includes the write statement for the first mapped rows. |
| `POST /jobs/source-preview` | First source rows (conditions applied, lookups attached), the read statement and each lookup's query; needs no target or mappings. |
| `POST /jobs/:id/runs` · `GET /jobs/:id/runs` | Start a run (`202`; body `{ "dryRun": true }` for a dry run), list history. |
| `POST /jobs/:id/reconcile` | Compare counts and a 200-row sample between source and target. Stores the counts as the job's latest reconcile. |
| `GET/DELETE /jobs/:id/watermark` | Read or reset the incremental watermark. |
| `GET /reconciles/latest` | Counts of the latest reconcile per job id (`ReconcileSummary`; no keys or values). |
| `GET /runs/latest` · `GET /runs/:id` · `POST /runs/:id/cancel` | Latest run per job, run detail with log, cancel. |
| `GET /health` | Liveness. |

## Testing

`engine/test/` holds unit tests for the pure parts (values, paths, transforms, SQL builders, schema inference, job validation) and for `SyncRunner` and `LookupEnricher` with in-memory readers and writers. They contain the tricky logic (batching, de-duplication, error policy, checkpoints, cancellation, lookup matching) and do not need a database to test.

`engine/test/integration/` runs the connectors against real databases in containers (`npm run test:integration`, needs Docker). It is kept out of `npm test` so unit tests stay fast and need nothing installed.

| File | What it covers |
| --- | --- |
| `containers.ts` | Starts PostgreSQL 16, MySQL 8.4, MongoDB 7 (optionally seeded from `sandbox/`) and the Linux "vnext" Cosmos DB emulator with Testcontainers. |
| `connector-contract.ts` | Behaviour every connector must have: ping, listing, describing, counting, batched and limited reads, inclusive watermark reads in order, cancellation, idempotent upserts, key lookups. Each connector's spec runs it. |
| `mysql.spec.ts` | Matching on key fields only (a clash on another unique column fails instead of updating another row), all-or-nothing batches, composite keys, booleans/JSON/big integers/UTC dates, read-only query sources, a `?` inside a user query left alone, MySQL-to-MySQL incremental job with reconcile. |
| `postgres.spec.ts` | All-or-nothing batches, splitting above the bind parameter limit, jsonb writes, nested paths read through their column, SQL query sources (reading, counting, watermarks, column types, the read-only guard). |
| `mongo.spec.ts` | `$set` keeps unmanaged fields, dotted names update nested fields, composite keys, BSON types survive a MongoDB-to-MongoDB copy, ObjectId watermarks. |
| `cosmos.spec.ts` | Numeric ids, nested partition keys, partition key and id checks, whole-document replacement, system fields stripped. |
| `sync.spec.ts` | Whole jobs on the sandbox data through `SyncService` and `SyncRunner`: the README's MongoDB-to-PostgreSQL job with reconciliation catching a tampered value and a deleted row; an incremental PostgreSQL-to-MongoDB job whose second run reads only the changed rows; PostgreSQL orders enriched from MongoDB customers by a lookup, including a missing required match; an aggregate SQL query source run incrementally. |

The HTTP flow, run locking and a 400,000-row backfill were verified by hand against PostgreSQL 16 during development and are not automated.

## Roadmap

1. One-to-many lookups: collect related rows into an array (customer → orders[]) for document targets.
2. Delete propagation: soft-delete flags, or a key diff against the source.
3. Change data capture: Postgres logical replication, MongoDB change streams, the Cosmos DB change feed.
4. Scheduling: run jobs on an interval while the engine is up.
