import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../src/common/errors';
import { ConnectionsRepository } from '../src/connections/connections.repository';
import { ConnectionsService } from '../src/connections/connections.service';
import { CsvFileStore } from '../src/connections/csv-file-store';
import { ConnectorFactory } from '../src/connectors/connector.factory';
import { SettingsRepository } from '../src/settings/settings.repository';
import { SettingsService } from '../src/settings/settings.service';
import { SecretBox } from '../src/storage/secret-box';
import { Workspace } from '../src/storage/workspace';

const MB = 1024 * 1024;
const ID = 'files-1';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A store over a fresh temp workspace whose upload limit is `limitMb`. */
async function setup(limitMb = 1) {
  const root = await mkdtemp(join(tmpdir(), 'syncforge-files-'));
  dirs.push(root);
  const workspace = new Workspace(root);
  const settings = new SettingsService(new SettingsRepository(workspace));
  await settings.update({ defaultBatchSize: 500, csvMaxUploadMb: limitMb });
  const store = new CsvFileStore(workspace, settings);
  return { workspace, settings, store, directory: store.directoryFor(ID) };
}

function body(content: string | Buffer): Readable {
  return Readable.from([Buffer.from(content)]);
}

/** A body sent as the given chunks, so a character can be split between two of them. */
function chunked(...chunks: Buffer[]): Readable {
  return Readable.from(chunks);
}

/** A body of `size` bytes that starts with a valid header row, sent in 64 KB chunks. */
function bigBody(size: number): Readable {
  const header = 'id,name\n';
  const chunk = 64 * 1024;
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= size) return void this.push(null);
      const length = Math.min(chunk, size - sent);
      this.push(sent === 0 ? Buffer.concat([Buffer.from(header), Buffer.alloc(length - header.length, 'x')]) : Buffer.alloc(length, 'x'));
      sent += length;
    },
  });
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

async function entries(directory: string): Promise<string[]> {
  return (await readdir(directory).catch(() => [])).sort();
}

describe('CsvFileStore', () => {
  it('saves an upload and lists it with its size', async () => {
    const { store, directory } = await setup();
    const saved = await store.save(ID, 'orders.csv', body('id,amount\n1,10\n'), { delimiter: 'auto' });
    expect(saved).toMatchObject({ name: 'orders.csv', size: 15 });
    expect(await readFile(join(directory, 'orders.csv'), 'utf8')).toBe('id,amount\n1,10\n');
    expect(await store.list(ID)).toEqual([saved]);
  });

  it('replaces a file of the same name with the new content', async () => {
    const { store, directory } = await setup();
    await store.save(ID, 'orders.csv', body('id\n1\n'), { delimiter: ',' });
    await store.save(ID, 'orders.csv', body('id;amount\n2;20\n'), { delimiter: 'auto' });
    expect(await readFile(join(directory, 'orders.csv'), 'utf8')).toBe('id;amount\n2;20\n');
    expect(await entries(directory)).toEqual(['orders.csv']);
  });

  it('lists nothing when nothing was uploaded, and sorts names while skipping temporary and other files', async () => {
    const { store, directory } = await setup();
    expect(await store.list(ID)).toEqual([]);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'b.csv'), 'id\n');
    await writeFile(join(directory, 'a.csv'), 'id\n');
    await writeFile(join(directory, '.c.csv.0123.part'), 'id\n');
    await writeFile(join(directory, 'notes.txt'), 'hello');
    expect((await store.list(ID)).map((file) => file.name)).toEqual(['a.csv', 'b.csv']);
  });

  it('refuses a declared length over the limit before reading the body', async () => {
    const { store, directory } = await setup(1);
    let read = false;
    const untouched = new Readable({
      read() {
        read = true;
        this.push(null);
      },
    });
    const error = await failure(store.save(ID, 'big.csv', untouched, { delimiter: 'auto', declaredLength: MB + 1 }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('File is larger than the 1 MB limit set in Settings');
    expect(read).toBe(false);
    expect(await entries(directory)).toEqual([]);
  });

  it('refuses a streamed body that grows past the limit, keeps the previous file and leaves no temporary file', async () => {
    const { store, directory } = await setup(1);
    await store.save(ID, 'big.csv', body('id\n1\n'), { delimiter: 'auto' });
    const error = await failure(store.save(ID, 'big.csv', bigBody(MB + 1), { delimiter: 'auto' }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('File is larger than the 1 MB limit set in Settings');
    expect(await readFile(join(directory, 'big.csv'), 'utf8')).toBe('id\n1\n');
    expect(await entries(directory)).toEqual(['big.csv']);
  });

  it('reads the rest of an oversized body, so the refusal reaches the client instead of a reset connection', async () => {
    const { store, directory } = await setup(1);
    const source = bigBody(3 * MB);
    const error = await failure(store.save(ID, 'big.csv', source, { delimiter: 'auto' }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('File is larger than the 1 MB limit set in Settings');
    expect(source.readableEnded).toBe(true);
    expect(source.errored).toBeNull();
    expect(await entries(directory)).toEqual([]);
  });

  it('removes the temporary file and keeps the previous one when the upload breaks off midway', async () => {
    const { store, directory } = await setup();
    await store.save(ID, 'orders.csv', body('id\n1\n'), { delimiter: 'auto' });
    const aborted = new Readable({
      read() {
        this.push(Buffer.from('id\n2\n'));
        // Like a client that closes the connection mid-upload.
        setImmediate(() => this.destroy(new Error('aborted')));
      },
    });
    const error = await failure(store.save(ID, 'orders.csv', aborted, { delimiter: 'auto' }));
    expect(error.message).toBe('aborted');
    expect(await readFile(join(directory, 'orders.csv'), 'utf8')).toBe('id\n1\n');
    expect(await entries(directory)).toEqual(['orders.csv']);
  });

  it('refuses a file that is not UTF-8 text, keeps the previous file and leaves no temporary file', async () => {
    const { store, directory } = await setup();
    await store.save(ID, 'orders.csv', body('id,name\n1,Ann\n'), { delimiter: 'auto' });
    // "Müller" saved as Windows-1252, as Excel's plain "CSV" format does.
    const error = await failure(store.save(ID, 'orders.csv', body(Buffer.from('id,name\n1,M\xFCller\n', 'latin1')), { delimiter: 'auto' }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('"orders.csv" is not UTF-8 text. Save it as "CSV UTF-8" and upload it again.');
    expect(await readFile(join(directory, 'orders.csv'), 'utf8')).toBe('id,name\n1,Ann\n');
    expect(await entries(directory)).toEqual(['orders.csv']);
  });

  it('refuses a file that ends in the middle of a UTF-8 character', async () => {
    const { store, directory } = await setup();
    const umlaut = Buffer.from('ü');
    const error = await failure(store.save(ID, 'cut.csv', chunked(Buffer.from('id,name\n1,M'), umlaut.subarray(0, 1)), { delimiter: 'auto' }));
    expect(error.message).toBe('"cut.csv" is not UTF-8 text. Save it as "CSV UTF-8" and upload it again.');
    expect(await entries(directory)).toEqual([]);
  });

  it('accepts UTF-8 with a byte order mark and characters split between chunks', async () => {
    const { store, directory } = await setup();
    const umlaut = Buffer.from('ü');
    const content = [Buffer.from('\uFEFFid,name\n1,M'), umlaut.subarray(0, 1), Buffer.concat([umlaut.subarray(1), Buffer.from('ller\n')])];
    await store.save(ID, 'names.csv', chunked(...content), { delimiter: 'auto' });
    expect(await readFile(join(directory, 'names.csv'), 'utf8')).toBe('\uFEFFid,name\n1,Müller\n');
  });

  it.skipIf(process.platform === 'win32')('keeps uploads readable by this user only', async () => {
    const { store, workspace, directory } = await setup();
    await store.save(ID, 'orders.csv', body('id\n1\n'), { delimiter: 'auto' });
    expect((await stat(workspace.local('uploads'))).mode & 0o777).toBe(0o700);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'orders.csv'))).mode & 0o777).toBe(0o600);
  });

  it('accepts a body of exactly the limit', async () => {
    const { store } = await setup(1);
    expect((await store.save(ID, 'edge.csv', bigBody(MB), { delimiter: 'auto' })).size).toBe(MB);
  });

  it('reads the limit from the settings at each upload', async () => {
    const { store, settings } = await setup(1);
    await settings.update({ defaultBatchSize: 500, csvMaxUploadMb: 2 });
    expect(await store.maxBytes()).toBe(2 * MB);
    expect((await store.save(ID, 'grown.csv', bigBody(MB + 1), { delimiter: 'auto' })).size).toBe(MB + 1);
  });

  it('refuses an empty file or an unusable header row and leaves nothing behind', async () => {
    const { store, directory } = await setup();
    const empty = await failure(store.save(ID, 'empty.csv', body(''), { delimiter: 'auto' }));
    expect(empty).toBeInstanceOf(ValidationError);
    expect(empty.message).toBe('empty.csv is empty: its first row must name the columns');
    const repeated = await failure(store.save(ID, 'dup.csv', body('id,id\n1,2\n'), { delimiter: 'auto' }));
    expect(repeated).toBeInstanceOf(ValidationError);
    expect(repeated.message).toBe('dup.csv: column "id" appears twice in the header row');
    const blank = await failure(store.save(ID, 'blank.csv', body('id;;name\n'), { delimiter: ';' }));
    expect(blank.message).toBe('blank.csv: column 2 of the header row has no name');
    expect(await entries(directory)).toEqual([]);
  });

  it('reports a broken header without quoting it', async () => {
    const { store, directory } = await setup();
    const error = await failure(store.save(ID, 'quote.csv', body('id,"secret value\n'), { delimiter: ',' }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toMatch(/^quote\.csv line \d+: /);
    expect(error.message).not.toContain('secret');
    expect(await entries(directory)).toEqual([]);
  });

  it('refuses names that are not CSV file names before touching the disk', async () => {
    const { store, workspace } = await setup();
    for (const name of ['../x.csv', '.hidden.csv', 'a/b.csv', 'orders.txt', '']) {
      expect(await failure(store.save(ID, name, body('id\n'), { delimiter: 'auto' }))).toBeInstanceOf(ValidationError);
      expect(await failure(store.remove(ID, name))).toBeInstanceOf(ValidationError);
    }
    expect(await entries(workspace.local())).toEqual(['settings']);
  });

  it('removes one file, reports a missing one, and removes every file of a connection', async () => {
    const { store, directory } = await setup();
    await store.save(ID, 'a.csv', body('id\n'), { delimiter: 'auto' });
    await store.save(ID, 'b.csv', body('id\n'), { delimiter: 'auto' });
    await store.remove(ID, 'a.csv');
    expect(await entries(directory)).toEqual(['b.csv']);
    const missing = await failure(store.remove(ID, 'a.csv'));
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(missing.message).toBe('"a.csv" is not uploaded to this connection');
    await store.removeAll(ID);
    await store.removeAll(ID);
    expect(await readdir(directory).catch((error: NodeJS.ErrnoException) => error.code)).toBe('ENOENT');
  });
});

describe('ConnectionsService files', () => {
  async function service() {
    const { workspace, store } = await setup();
    const secrets = await SecretBox.load(join(workspace.root, 'secret.key'));
    // Files never open a connector, so the factory is not needed.
    const connections = new ConnectionsService(new ConnectionsRepository(workspace.local('connections')), secrets, {} as ConnectorFactory, store);
    return { connections, store };
  }

  it('saves, lists and removes the files of a CSV connection, with the current limit', async () => {
    const { connections } = await service();
    const { id } = await connections.create({ name: 'files', config: { kind: 'csv', delimiter: ';' } });
    await connections.saveFile(id, 'orders.csv', body('id;amount\n1;10\n'), 15);
    const listed = await connections.listFiles(id);
    expect(listed.maxBytes).toBe(MB);
    expect(listed.files.map((file) => file.name)).toEqual(['orders.csv']);
    await connections.removeFile(id, 'orders.csv');
    expect((await connections.listFiles(id)).files).toEqual([]);
  });

  it('uses the connection delimiter to check the header row', async () => {
    const { connections } = await service();
    const { id } = await connections.create({ name: 'files', config: { kind: 'csv', delimiter: ';' } });
    // Read with ";", the comma header is one column, so the repeated name is never seen.
    await connections.saveFile(id, 'commas.csv', body('id,id\n1,2\n'));
    expect((await connections.listFiles(id)).files.map((file) => file.name)).toEqual(['commas.csv']);
  });

  it('refuses files for connections that are not CSV', async () => {
    const { connections } = await service();
    const { id } = await connections.create({
      name: 'pg',
      config: { kind: 'postgres', host: 'localhost', port: 5432, database: 'db', user: 'u', password: '', ssl: 'disable' },
    });
    const attempts = [() => connections.listFiles(id), () => connections.saveFile(id, 'a.csv', body('id\n')), () => connections.removeFile(id, 'a.csv')];
    for (const attempt of attempts) {
      const error = await failure(attempt());
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.message).toBe('Only CSV connections hold files');
    }
  });

  it('deletes the uploaded files with their connection', async () => {
    const { connections, store } = await service();
    const { id } = await connections.create({ name: 'files', config: { kind: 'csv', delimiter: 'auto' } });
    await connections.saveFile(id, 'a.csv', body('id\n1\n'));
    await connections.remove(id);
    expect(await readdir(store.directoryFor(id)).catch((error: NodeJS.ErrnoException) => error.code)).toBe('ENOENT');
  });

  it('deletes the uploaded files of a connection whose kind changed from CSV', async () => {
    const { connections, store } = await service();
    const { id } = await connections.create({ name: 'files', config: { kind: 'csv', delimiter: 'auto' } });
    await connections.saveFile(id, 'a.csv', body('id\n1\n'));
    await connections.update(id, {
      name: 'files',
      config: { kind: 'postgres', host: 'localhost', port: 5432, database: 'db', user: 'u', password: 'p', ssl: 'disable' },
    });
    await connections.remove(id);
    expect(await readdir(store.directoryFor(id)).catch((error: NodeJS.ErrnoException) => error.code)).toBe('ENOENT');
  });
});
