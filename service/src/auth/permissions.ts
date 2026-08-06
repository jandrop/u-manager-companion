/**
 * Operation -> required action+resource permission map, and the
 * authorization check against a resolved identity.
 *
 * Permission gates by area:
 *   - docker template install/edit/delete, docker update streams -> DOCKER (update)
 *   - power shutdown/reboot/sleep -> SERVERS (update)
 *   - plugin uninstall/update-check -> CONFIG (update), the resource
 *     unraid-api's own installPlugin mutation gates on. Unraid has no
 *     PLUGINS resource, so no key can be granted one.
 *   - updateDiskThresholds -> DISPLAY (update); the diskThresholds READ
 *     query is ungated in resolvers.ts, same posture as the shares reads
 *   - shares mutations (create/update/delete/security/access) -> SHARE (update)
 *     (Unraid's own permission model splits share access into separate
 *     CREATE_ANY/UPDATE_ANY/DELETE_ANY grants on Resource.SHARE; this service
 *     collapses that to a single 'shares' capability key gated on
 *     SHARE:update -- v1 has no per-CRUD-verb permission granularity, matching
 *     every other v1 capability's single update-gate posture)
 *
 * Operation keys reuse CAPABILITY_KEYS naming (schema/version.ts) so the
 * same string identifies a capability AND a permission-checked
 * operation -- one vocabulary, not two. Read-only share queries
 * (shares/shareSecurity/shareSecurityUsers/shareIsEmpty) are NOT
 * permission-gated in resolvers.ts -- same posture as `capabilities`
 * itself: any authenticated identity satisfies a read-only gate once past
 * auth, so these queries don't need per-permission checks.
 *
 * "Ungated" means ungated by PERMISSION, not by authentication: server.ts
 * resolves an identity before every HTTP request, `capabilities`
 * included, so an unrecognised key is refused that query too.
 */
import type { CapabilityKey } from '../schema/version.js';
import type { Authority, ResolvedIdentity } from './keystore.js';

/** Every companion operation that goes through the permission gate.
 * A strict subset/alias of CapabilityKey -- kept as its own type so a
 * future capability that's read-only-and-ungated doesn't have to appear
 * here. */
export type CompanionOperation = CapabilityKey;

export type PermissionResource = 'DOCKER' | 'SERVERS' | 'CONFIG' | 'SHARE' | 'DISPLAY';
export type PermissionAction = 'update';

export interface RequiredPermission {
  readonly resource: PermissionResource;
  readonly action: PermissionAction;
}

/**
 * Static operation -> permission map. Every v1 capability is privileged
 * (update action) -- v1 has no read-gated companion operations besides
 * `capabilities` itself, which is intentionally NOT PERMISSION-gated
 * (it's the detection signal, and carries no sensitive data). It still
 * requires a recognised key: see the header on what "ungated" means.
 */
export const OPERATION_PERMISSIONS: Readonly<Record<CompanionOperation, RequiredPermission>> = {
  'docker.templateInstall': { resource: 'DOCKER', action: 'update' },
  'docker.templateEdit': { resource: 'DOCKER', action: 'update' },
  'docker.templateDelete': { resource: 'DOCKER', action: 'update' },
  'docker.updateStream': { resource: 'DOCKER', action: 'update' },
  'docker.checkForUpdates': { resource: 'DOCKER', action: 'update' },
  power: { resource: 'SERVERS', action: 'update' },
  'plugins.uninstall': { resource: 'CONFIG', action: 'update' },
  'plugins.checkForUpdates': { resource: 'CONFIG', action: 'update' },
  // Never actually checked -- installedUnraidPluginsDetailed is a read-only
  // query, ungated in resolvers.ts (same posture as the shares reads). This
  // entry exists only because OPERATION_PERMISSIONS is a total map over
  // CapabilityKey.
  'plugins.installedDetailed': { resource: 'CONFIG', action: 'update' },
  shares: { resource: 'SHARE', action: 'update' },
  diskThresholds: { resource: 'DISPLAY', action: 'update' },
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
      // Unraid lets a grant name every resource at once.
      const wildcardKey = `*:${required.action}`;
      return identity.permissions.some(
        (permission) => permission === requiredKey || permission === wildcardKey,
      );
    }
    case 'none':
    default:
      return false;
  }
}
