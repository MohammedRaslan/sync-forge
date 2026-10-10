import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Integration tests need Docker and run separately: npm run test:integration
  test: { include: ['test/**/*.spec.ts'], exclude: ['test/integration/**'], environment: 'node' },
});
