import { defineConfig } from 'vitest/config';

/** Connector tests against real databases in Docker containers (Testcontainers). */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.spec.ts'],
    environment: 'node',
    // Pulling images and booting the Cosmos DB emulator can take minutes on a cold machine.
    hookTimeout: 300_000,
    testTimeout: 60_000,
  },
});
