import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Mirrors build/bundle.mjs's esbuild `loader: { '.graphql': 'text' }` step
 * for the vitest/Vite dev-time module graph: server.ts imports
 * schema/schema.graphql directly as a string (task 7.1), and esbuild's text
 * loader handles that at real-bundle time, but Vite's default pipeline tries
 * to parse .graphql files as JS/TS and fails import analysis. This plugin
 * gives Vite/vitest the SAME "import the file's content as a default-export
 * string" behavior, so dev/test and the bundled artifact see identical
 * values for schemaGraphqlSourceText.
 */
function graphqlTextLoader(): Plugin {
  return {
    name: 'graphql-text-loader',
    transform(_code, id) {
      if (!id.endsWith('.graphql')) return null;
      const content = readFileSync(id, 'utf8');
      return {
        code: `export default ${JSON.stringify(content)};`,
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [graphqlTextLoader()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: 'default',
    // SEA/bundle smoke tests spawn a child process and wait for a port bind;
    // give them more headroom than vitest's default 5s.
    testTimeout: 15_000,
  },
});
