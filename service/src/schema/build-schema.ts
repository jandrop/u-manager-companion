import { makeExecutableSchema } from '@graphql-tools/schema';
import type { IResolvers } from '@graphql-tools/utils';
// @ts-expect-error -- .graphql has no type declaration; esbuild's text loader
// inlines it as a string at bundle time, vitest via graphql-text-loader.
import schemaGraphqlSourceText from './schema.graphql';

import { resolvers } from '../resolvers.js';

/** Split out of server.ts so tests can build the schema without dragging in
 * Apollo, graphql-ws and the real platform wiring. */
export function buildExecutableSchema() {
  return makeExecutableSchema({
    typeDefs: schemaGraphqlSourceText as unknown as string,
    // resolvers.ts types its map against GraphqlContext; makeExecutableSchema
    // wants the broad shape, so the cast lives here and only here.
    resolvers: resolvers as unknown as IResolvers,
  });
}
