/**
 * schema/catalogue parity gate.
 *
 * Loads the v1 companion GraphQL operation documents straight out of the
 * app repo's op catalogue (packages/unraid_api/lib/src/graphql/companion)
 * and validates each one against this service's own schema.graphql using
 * graphql-js's `validate()`. This is a READ-ONLY cross-repo reference --
 * no app repo files are modified by this test, and no assumption is made
 * about the app repo's own toolchain (we only regex-extract raw GraphQL
 * document strings out of .dart source).
 *
 * Scope: only the v1 op documents the SDL actually covers (docker
 * template install/edit/delete, docker update streams + checkForUpdates,
 * serverPower shutdown/reboot/sleep, unraidPlugins uninstall/checkForUpdates,
 * dockerInstallOperation query, dockerInstallUpdates subscription). The
 * companion catalogue also carries shares/network/array/metrics/plugins-
 * detailed ops that are explicitly OUT of v1 schema scope (those other
 * domains aren't part of the v1 shape) -- parity for those is not this
 * gate's job.
 *
 * TDD: written before the extraction helper exists -> RED first.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';

const SDL_PATH = path.join(__dirname, '..', 'schema.graphql');

// Repo-relative path from this service package to the app repo's op
// catalogue. Read-only reference -- never written to.
const APP_REPO_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'Flutter',
  'Personal',
  'u_manager',
);
const COMPANION_CATALOGUE_ROOT = path.join(
  APP_REPO_ROOT,
  'packages',
  'unraid_api',
  'lib',
  'src',
  'graphql',
  'companion',
);

/** The specific v1 op-catalogue files the SDL (schema.graphql) covers. */
const V1_CATALOGUE_FILES = [
  'mutations/unraid_graphql_docker_template_mutations.dart',
  'mutations/unraid_graphql_docker_mutations.dart',
  'mutations/unraid_graphql_server_power_mutations.dart',
  'mutations/unraid_graphql_plugins_mutations.dart',
  'queries/unraid_graphql_docker_template_queries.dart',
  'subscriptions/unraid_graphql_docker_template_subscriptions.dart',
] as const;

interface ExtractedOperation {
  /** e.g. "InstallDockerTemplate" -- the GraphQL operation name. */
  name: string;
  /** Source .dart file the operation was extracted from, for error messages. */
  sourceFile: string;
  /** Raw GraphQL document text (operation body only). */
  document: string;
}

/**
 * Extracts every `static const String ... = r'''...''';` (or the
 * non-raw `'''...'''` variant) GraphQL document from a .dart source file.
 * Matches both the raw-string (`r'''`) and plain triple-quoted forms the
 * companion catalogue uses interchangeably (raw strings are used only
 * when the document needs literal `$` for GraphQL variables that would
 * otherwise be read as Dart string interpolation).
 */
function extractOperations(dartSource: string, sourceFile: string): ExtractedOperation[] {
  const pattern = /static const String \w+\s*=\s*r?'''([\s\S]*?)''';/g;
  const operations: ExtractedOperation[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(dartSource)) !== null) {
    const document = match[1]!.trim();
    const nameMatch = /\b(?:query|mutation|subscription)\s+(\w+)/.exec(document);
    if (!nameMatch) {
      throw new Error(
        `${sourceFile}: could not find an operation name in extracted document:\n${document}`,
      );
    }
    operations.push({ name: nameMatch[1]!, sourceFile, document });
  }
  return operations;
}

function loadV1Operations(): ExtractedOperation[] {
  const operations: ExtractedOperation[] = [];
  for (const relativePath of V1_CATALOGUE_FILES) {
    const filePath = path.join(COMPANION_CATALOGUE_ROOT, relativePath);
    const source = readFileSync(filePath, 'utf8');
    operations.push(...extractOperations(source, relativePath));
  }
  return operations;
}

describe('schema/catalogue parity', () => {
  it('finds the app repo companion op catalogue on disk', () => {
    // Fails loudly (not silently skips) if the sibling repo checkout is
    // missing/moved -- this gate is meaningless without it.
    expect(() => loadV1Operations()).not.toThrow();
  });

  it('extracts at least one operation per v1 catalogue file', () => {
    for (const relativePath of V1_CATALOGUE_FILES) {
      const filePath = path.join(COMPANION_CATALOGUE_ROOT, relativePath);
      const source = readFileSync(filePath, 'utf8');
      const ops = extractOperations(source, relativePath);
      expect(ops.length, `${relativePath} should declare at least one op`).toBeGreaterThan(0);
    }
  });

  it('validates every extracted v1 operation against schema.graphql with zero errors', () => {
    const sdl = readFileSync(SDL_PATH, 'utf8');
    const schema = buildSchema(sdl);
    const operations = loadV1Operations();
    expect(operations.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const op of operations) {
      let document;
      try {
        document = parse(op.document);
      } catch (error) {
        failures.push(`${op.sourceFile} (${op.name}): failed to parse -- ${String(error)}`);
        continue;
      }
      const errors = validate(schema, document);
      if (errors.length > 0) {
        failures.push(
          `${op.sourceFile} (${op.name}): ${errors.map((e) => e.message).join('; ')}`,
        );
      }
    }

    expect(failures, failures.join('\n')).toHaveLength(0);
  });
});
