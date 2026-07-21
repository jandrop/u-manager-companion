/**
 * pubsub.ts tests.
 *
 * Verifies the per-operation channel-naming helper and that the underlying
 * PubSub instance actually delivers published payloads to subscribers on
 * the matching channel only -- the property the operation engine (registry.ts)
 * depends on for delta-event delivery.
 */
import { describe, expect, it } from 'vitest';
import { channelFor, pubsub } from './pubsub';

describe('channelFor', () => {
  it('builds a channel name as "<CHANNEL>:<id>"', () => {
    expect(channelFor('DOCKER_INSTALL', 'abc-123')).toBe('DOCKER_INSTALL:abc-123');
  });

  it('produces distinct channels for distinct operation ids under the same prefix', () => {
    expect(channelFor('DOCKER_INSTALL', 'a')).not.toBe(channelFor('DOCKER_INSTALL', 'b'));
  });

  it('produces distinct channels for distinct prefixes under the same id', () => {
    expect(channelFor('DOCKER_INSTALL', 'x')).not.toBe(channelFor('PLUGIN_INSTALL', 'x'));
  });
});

describe('pubsub (shared in-process PubSub instance)', () => {
  it('delivers a published payload only to subscribers of the matching channel', async () => {
    const channel = channelFor('DOCKER_INSTALL', 'op-1');
    const otherChannel = channelFor('DOCKER_INSTALL', 'op-2');

    const received: unknown[] = [];
    const subId = await pubsub.subscribe(channel, (payload: unknown) => {
      received.push(payload);
    });
    const otherReceived: unknown[] = [];
    const otherSubId = await pubsub.subscribe(otherChannel, (payload: unknown) => {
      otherReceived.push(payload);
    });

    try {
      await pubsub.publish(channel, { hello: 'world' });
      // graphql-subscriptions delivers via the Node event loop's microtask
      // queue synchronously for the in-process EventEmitter transport, but
      // await a tick to avoid coupling the test to that implementation detail.
      await new Promise((resolve) => setImmediate(resolve));

      expect(received).toEqual([{ hello: 'world' }]);
      expect(otherReceived).toEqual([]);
    } finally {
      pubsub.unsubscribe(subId);
      pubsub.unsubscribe(otherSubId);
    }
  });
});
