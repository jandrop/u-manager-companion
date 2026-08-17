/**
 * dockerContainerStats driven through graphql-js's real subscribe(), not a
 * unit test of the resolver map -- the one place this repo verifies whether
 * graphql-tools passes a subscription payload through by default (D7's
 * "unverified assumption", neutralised here rather than left open).
 *
 * TDD: written before the resolver/schema wiring exists -> RED first.
 */
import type { ExecutionResult } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

// Must match the CJS `graphql` instance @graphql-tools/schema loads, or
// graphql-js's isSchema() guard rejects the schema. vite-node only (see
// enum-serialization.test.ts for the same pattern).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse, subscribe } = require('graphql') as typeof import('graphql');

import { buildExecutableSchema } from '../build-schema.js';
import type { GraphqlContext } from '../../resolvers.js';
import type { ResolvedIdentity } from '../../auth/keystore.js';
import type { DockerContainerStatsSample } from '../../features/docker_stats/map.js';

const DOCUMENT = parse(`subscription { dockerContainerStats { id cpuPercent memUsedBytes memTotalBytes } }`);

function makeIdentity(): ResolvedIdentity {
  return { id: 'u1', name: 'admin', roles: ['ADMIN'], permissions: [], authority: 'full' };
}

function sample(id: string): DockerContainerStatsSample {
  return {
    id,
    cpuPercent: 12.5,
    memUsedBytes: 100,
    memTotalBytes: 200,
    netRxBytes: null,
    netTxBytes: null,
    blkReadBytes: null,
    blkWriteBytes: null,
    sampledAtMs: 1_700_000_000_000,
  };
}

describe('dockerContainerStats -- executed through graphql.subscribe()', () => {
  it('delivers a batch through the real schema', async () => {
    const schema = buildExecutableSchema();
    const batch = [sample('c1')];
    async function* oneBatch(): AsyncGenerator<readonly DockerContainerStatsSample[]> {
      yield batch;
    }
    const context: GraphqlContext = {
      identity: makeIdentity(),
      deps: {
        subscribeDockerContainerStats: vi.fn().mockResolvedValue(oneBatch()),
      } as unknown as GraphqlContext['deps'],
    };

    const result = await subscribe({ schema, document: DOCUMENT, contextValue: context });
    expect(Symbol.asyncIterator in result).toBe(true);

    const { value } = await (result as AsyncGenerator<ExecutionResult>).next();
    expect(value.errors).toBeUndefined();
    expect(value.data).toEqual({
      dockerContainerStats: [{ id: 'c1', cpuPercent: 12.5, memUsedBytes: 100, memTotalBytes: 200 }],
    });
  });

  it('errors (does not silently yield an empty stream) when the engine probe fails', async () => {
    const schema = buildExecutableSchema();
    const context: GraphqlContext = {
      identity: makeIdentity(),
      deps: {
        subscribeDockerContainerStats: vi.fn().mockRejectedValue(new Error('Docker engine unreachable: boom')),
      } as unknown as GraphqlContext['deps'],
    };

    const result = await subscribe({ schema, document: DOCUMENT, contextValue: context });

    // graphql-js turns a rejected subscribe-field resolver into a plain
    // ExecutionResult with errors, NOT an AsyncIterable -- the exact
    // mechanism that lets graphql-ws relay an explicit client error instead
    // of establishing a silent stream.
    expect(Symbol.asyncIterator in result).toBe(false);
    expect((result as ExecutionResult).errors?.[0]?.message).toMatch(/Docker engine unreachable/);
  });
});
