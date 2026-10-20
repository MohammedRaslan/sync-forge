import { describe, expect, it } from 'vitest';
import { StandaloneConnection, runJob } from '../src/standalone';

/** An HTTP API connection as an exported script writes it: no `maxResponseBytes`, the secret from the environment. */
function api(name: string, secret: string): StandaloneConnection {
  return {
    name,
    config: { kind: 'http', baseUrl: 'http://127.0.0.1:9/v2', auth: { type: 'bearer' }, secret, endpoints: [{ name: 'users', path: '/users' }] },
  };
}

const job = {
  id: 'users-1a2b3c',
  name: 'Users',
  source: { connectionId: 'users-api', collection: 'users' },
  target: { connectionId: 'other-api', collection: 'users', keyFields: ['id'] },
  mappings: [{ from: 'id', to: 'id', transform: 'none' as const }],
  mode: 'full' as const,
  batchSize: 100,
  errorPolicy: 'fail' as const,
};

describe('exported scripts with HTTP API connections', () => {
  it('refuses to start when the token environment variable is empty', async () => {
    await expect(runJob({ job, connections: { 'users-api': api('Users API', ''), 'other-api': api('Other API', 'x') } })).rejects.toThrow(
      'Connection "Users API" needs its secret',
    );
  });

  it('opens HTTP API settings without a response size limit and applies the same rules as the app', async () => {
    // Both connections parse and open; the job is refused by the target rule before any request is sent.
    await expect(runJob({ job, connections: { 'users-api': api('Users API', 'x'), 'other-api': api('Other API', 'x') } })).rejects.toThrow(
      'HTTP API connections can be a source or a lookup, not a target',
    );
  });
});
