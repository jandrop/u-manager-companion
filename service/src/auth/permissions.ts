/**
 * Operation -> required action+resource permission map, and the
 * authorization check against a resolved identity.
 *
 * Mapping mirrors the permission gates already encoded in the legacy
 * patches:
 *   - docker template install/edit/delete, docker update streams -> DOCKER (update)
 *   - power shutdown/reboot/sleep -> SERVERS (update)
 *   - plugin uninstall/update-check -> PLUGINS (update)
 *
 * Operation keys reuse CAPABILITY_KEYS naming (schema/version.ts) so the
 * same string identifies a capability AND a permission-checked
 * operation -- one vocabulary, not two.
 */
import type { CapabilityKey } from '../schema/version.js';
import type { Authority, ResolvedIdentity } from './keystore.js';

/** Every companion operation that goes through the permission gate.
 * A strict subset/alias of CapabilityKey -- kept as its own type so a
 * future capability that's read-only-and-ungated doesn't have to appear
 * here. */
export type CompanionOperation = CapabilityKey;

export type PermissionResource = 'DOCKER' | 'SERVERS' | 'PLUGINS';
export type PermissionAction = 'update';

export interface RequiredPermission {
  readonly resource: PermissionResource;
  readonly action: PermissionAction;
}

/**
 * Static operation -> permission map. Every v1 capability is privileged
 * (update action) -- v1 has no read-gated companion operations besides
 * `capabilities` itself, which is intentionally NOT auth-gated (it's the
 * detection signal, and carries no sensitive data).
 */
export const OPERATION_PERMISSIONS: Readonly<Record<CompanionOperation, RequiredPermission>> = {
  'docker.templateInstall': { resource: 'DOCKER', action: 'update' },
  'docker.templateEdit': { resource: 'DOCKER', action: 'update' },
  'docker.templateDelete': { resource: 'DOCKER', action: 'update' },
  'docker.updateStream': { resource: 'DOCKER', action: 'update' },
  'docker.checkForUpdates': { resource: 'DOCKER', action: 'update' },
  power: { resource: 'SERVERS', action: 'update' },
  'plugins.uninstall': { resource: 'PLUGINS', action: 'update' },
  'plugins.checkForUpdates': { resource: 'PLUGINS', action: 'update' },
};

function permissionKey(permission: RequiredPermission): string {
  return `${permission.resource}:${permission.action}`;
}

/**
 * Authorization decision for a resolved identity against a specific
 * operation, per authority kind:
 *   - 'full'      (ADMIN, empty permissions)         -> always authorized.
 *   - 'read-only' (VIEWER, empty permissions)         -> never authorized
 *                                                        for privileged ops.
 *   - 'scoped'    (non-empty permissions array, OR
 *                  the `{ me }` fallback's conservative
 *                  default)                            -> authorized only
 *                                                        if the required
 *                                                        `RESOURCE:action`
 *                                                        string is present
 *                                                        in `permissions`.
 *   - 'none'      (no recognised role, no permissions)  -> never authorized
 *                                                        (fail-closed).
 *
 * The `{ me }` fallback deliberately resolves to 'scoped' with an EMPTY
 * permissions array (identity.ts) -- under this scheme that denies every
 * privileged operation by default: conservative means "no privileged
 * access unless explicitly scoped," not "full access."
 */
export function isAuthorized(
  identity: ResolvedIdentity,
  operation: CompanionOperation,
): boolean {
  const required = OPERATION_PERMISSIONS[operation];

  switch (identity.authority as Authority) {
    case 'full':
      return true;
    case 'read-only':
      return false;
    case 'scoped': {
      const requiredKey = permissionKey(required);
      return identity.permissions.some((permission) => permission === requiredKey);
    }
    case 'none':
    default:
      return false;
  }
}
