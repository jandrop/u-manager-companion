/**
 * nginx include-file content builder tests.
 *
 * TDD: written before include.ts exists -> RED first.
 */
import { describe, expect, it } from 'vitest';
import { buildIncludeFileContent } from '../include.js';

describe('buildIncludeFileContent', () => {
  it('proxies to the loopback service port', () => {
    const content = buildIncludeFileContent({ port: 34400 });
    expect(content).toContain('proxy_pass http://127.0.0.1:34400;');
  });

  it('declares the /companion/graphql location', () => {
    const content = buildIncludeFileContent({ port: 34400 });
    expect(content).toContain('location /companion/graphql {');
  });

  it('sets `allow all` so the webgui auth layer does not intercept the endpoint', () => {
    // The endpoint does its own x-api-key auth (like the native /graphql
    // location, which also carries `allow all`). Without this, the webgui's
    // access rules 302-redirect API calls to /login. Verified live on box.
    const content = buildIncludeFileContent({ port: 34400 });
    expect(content).toContain('allow all;');
  });

  it('forwards Upgrade/Connection headers for WebSocket subscriptions', () => {
    const content = buildIncludeFileContent({ port: 34400 });
    expect(content).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(content).toContain('proxy_set_header Connection $connection_upgrade;');
  });

  it('sets proxy_http_version 1.1 (required for upgrade to work at all)', () => {
    const content = buildIncludeFileContent({ port: 34400 });
    expect(content).toContain('proxy_http_version 1.1;');
  });

  it('passes through the x-api-key header', () => {
    const content = buildIncludeFileContent({ port: 34400 });
    expect(content).toContain('proxy_set_header x-api-key $http_x_api_key;');
  });

  it('preserves the original Host header', () => {
    const content = buildIncludeFileContent({ port: 34400 });
    expect(content).toContain('proxy_set_header Host $host;');
  });

  it('reflects a different port when configured', () => {
    const content = buildIncludeFileContent({ port: 9999 });
    expect(content).toContain('proxy_pass http://127.0.0.1:9999;');
  });

  it('rejects an invalid port', () => {
    expect(() => buildIncludeFileContent({ port: 0 })).toThrow();
    expect(() => buildIncludeFileContent({ port: 70000 })).toThrow();
  });
});
