/**
 * In-process PubSub.
 *
 * Backs the streaming-operation pattern: a mutation starts work and
 * registers an operation; the operation engine (operations/registry.ts)
 * publishes delta events on a per-operation channel; a `Subscription`
 * resolver relays those events to the connected `graphql-ws` client.
 *
 * One process-lifetime `PubSub` instance is shared by every operation --
 * channel names are namespaced per-operation (see `channelFor`) so
 * concurrent operations never cross-deliver events to each other's
 * subscribers. This mirrors the channel-per-operation model in the
 * reference bundle patch (docker_template_create.py's
 * `CHANNEL_PREFIX + id`), just typed and reusable across feature modules
 * instead of hardcoded to a single Docker-install channel prefix.
 */
import { PubSub } from 'graphql-subscriptions';

/** Shared in-process PubSub instance for the lifetime of the service process. */
export const pubsub = new PubSub();

/**
 * Builds the channel name for a given operation-kind prefix and operation id,
 * as `<CHANNEL>:<id>`. Every streaming feature (docker install, docker
 * update, plugin install/uninstall) gets its own prefix so channel names
 * never collide across feature kinds even if operation ids ever did.
 */
export function channelFor(channelPrefix: string, operationId: string): string {
  return `${channelPrefix}:${operationId}`;
}
