import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Integration tests need Docker and run separately: npm run test:integration
  test: {
    include: ['test/**/*.spec.ts'],
    exclude: ['test/integration/**'],
    environment: 'node',
    // A zone that is never UTC (+02:00/+03:00), so date code that reads text as local time fails here
    // on every machine, CI included.
    env: { TZ: 'Europe/Athens' },
  },
});
