/**
 * Operation -> required action+resource map, plus the authority check
 * against a resolved identity.
 *
 * Mapping:
 *   - docker template install/edit/delete, docker update streams -> DOCKER (create/update)
 *   - power shutdown/reboot/sleep -> SERVERS (update)
 *   - plugin uninstall/update-check -> the plugin resource (update)
 *
 * Key-store path yields real permissions/roles; `{ me }` fallback path
 * ('scoped' authority, no explicit permissions) grants a CONSERVATIVE
 * default -- this must not be treated as automatic full access.
 *
 * TDD: written before permissions.ts exists -> RED first.
 */
import { describe, expect, it } from 'vitest';
import {
  OPERATION_PERMISSIONS,
  isAuthorized,
  type CompanionOperation,
} from '../permissions.js';
import type { ResolvedIdentity } from '../keystore.js';

function identity(overrides: Partial<ResolvedIdentity>): ResolvedIdentity {
  return {
    id: 'id-1',
    name: 'test-identity',
    roles: [],
    permissions: [],
    authority: 'none',
    ...overrides,
  };
}

describe('OPERATION_PERMISSIONS', () => {
  it('maps docker template install/edit/delete and update streams to DOCKER:update', () => {
    const dockerOps: CompanionOperation[] = [
      'docker.templateInstall',
      'docker.templateEdit',
      'docker.templateDelete',
      'docker.updateStream',
    ];
    for (const op of dockerOps) {
      expect(OPERATION_PERMISSIONS[op]).toEqual({ resource: 'DOCKER', action: 'update' });
    }
  });

  it('maps power shutdown/reboot/sleep to SERVERS:update', () => {
    expect(OPERATION_PERMISSIONS['power']).toEqual({ resource: 'SERVERS', action: 'update' });
  });

  it('maps plugin uninstall to the plugin resource, update action', () => {
    expect(OPERATION_PERMISSIONS['plugins.uninstall']).toEqual({
      resource: 'PLUGINS',
      action: 'update',
    });
  });

  it('maps plugin update-check (read-only) to the plugin resource with the update action', () => {
    // Plugin uninstall/update-check are grouped together under the
    // plugin resource, update action -- update-check itself is
    // non-privileged for AUDIT purposes but still requires an
    // authenticated+authorized identity to invoke.
    expect(OPERATION_PERMISSIONS['plugins.checkForUpdates']).toEqual({
      resource: 'PLUGINS',
      action: 'update',
    });
  });
});

describe('isAuthorized', () => {
  it('grants full authority (ADMIN, empty permissions) access to every operation', () => {
    const admin = identity({ authority: 'full' });
    for (const op of Object.keys(OPERATION_PERMISSIONS) as CompanionOperation[]) {
      expect(isAuthorized(admin, op)).toBe(true);
    }
  });

  it('denies read-only authority (VIEWER, empty permissions) access to every privileged operation', () => {
    const viewer = identity({ authority: 'read-only' });
    for (const op of Object.keys(OPERATION_PERMISSIONS) as CompanionOperation[]) {
      expect(isAuthorized(viewer, op)).toBe(false);
    }
  });

  it('grants scoped authority access when explicit permissions cover the resource:action pair', () => {
    const scoped = identity({ authority: 'scoped', permissions: ['DOCKER:update'] });
    expect(isAuthorized(scoped, 'docker.templateInstall')).toBe(true);
    expect(isAuthorized(scoped, 'power')).toBe(false);
  });

  it('denies scoped authority with no matching explicit permission (conservative default, { me } fallback case)', () => {
    const meFallback = identity({ authority: 'scoped', permissions: [] });
    expect(isAuthorized(meFallback, 'docker.templateInstall')).toBe(false);
    expect(isAuthorized(meFallback, 'power')).toBe(false);
  });

  it('denies "none" authority access to every operation (fail-closed default)', () => {
    const none = identity({ authority: 'none' });
    expect(isAuthorized(none, 'plugins.uninstall')).toBe(false);
  });
});
