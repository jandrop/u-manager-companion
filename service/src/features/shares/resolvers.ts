/**
 * Shares feature module.
 *
 * Every exported function here is the business-logic counterpart of one
 * SDL field (schema/schema.graphql's root `shares`/`shareSecurity`/
 * `shareSecurityUsers`/`shareIsEmpty` queries and `createShare`/
 * `updateShare`/`deleteShare`/`updateShareSecurity`/`updateShareAccess`
 * mutations). `src/resolvers.ts` binds these to the SDL with permission
 * gating; this module holds the actual behavior, delegating all IO to the
 * injected `EmhttpdClient` (platform.ts) so nothing here shells out or
 * touches a filesystem directly.
 *
 * Every mutation records an audit entry BEFORE the emhttpd round-trip
 * completes (`outcome: 'initiated'`) -- these are synchronous
 * request/response operations (unlike the streamed docker/plugin ops), so
 * there is no operation-registry snapshot to update to succeeded/failed;
 * 'initiated' is the terminal outcome recorded, matching the audit
 * module's documented posture for actions with no separate completion
 * signal to capture.
 */
import type { AuditCaller, AuditLogger } from '../../audit.js';
import type {
  EmhttpdClient,
  ShareAccessEntry,
  ShareRecord,
  ShareSecurity,
  ShareSecurityUpdateInput,
  ShareSecurityUser,
  ShareSettingsInput,
} from './platform.js';
import { buildShareCommands, isEmhttpdFailureResponse } from './platform.js';

/** Poll window for createShare waiting for the new share to appear in the
 * in-memory store. */
const CREATE_POLL_MAX_MS = 10_000;
const CREATE_POLL_STEP_MS = 50;
/** Fixed settle delay for updateShare/updateShareSecurity/
 * updateShareAccess -- a best-effort wait for the state file to refresh
 * before re-reading. */
const UPDATE_SETTLE_DELAY_MS = 300;
const SECURITY_SETTLE_DELAY_MS = 150;

const VALID_SHARE_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateShareName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new Error('Share name is required.');
  }
  if (name.length > 40) {
    throw new Error('Share name must be at most 40 characters.');
  }
  if (!VALID_SHARE_NAME_RE.test(name)) {
    throw new Error(
      'Invalid share name. Must start with a letter and contain only letters, digits, dot, underscore or hyphen.',
    );
  }
  if (name.endsWith('.')) {
    throw new Error('Share name may not end with a dot.');
  }
}

interface ClientDeps {
  readonly client: EmhttpdClient;
}

interface MutationDeps extends ClientDeps {
  readonly audit: AuditLogger;
  readonly caller: AuditCaller;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Backs `Query.shares`. Read-only -- NOT audited. */
export async function listShares(deps: ClientDeps): Promise<readonly ShareRecord[]> {
  return deps.client.getShares();
}

/** Backs `Query.shareSecurity(name)`. Read-only -- NOT audited. */
export async function getShareSecurity(name: string, deps: ClientDeps): Promise<ShareSecurity> {
  return deps.client.readShareSecurity(name);
}

/** Backs `Query.shareSecurityUsers`. Read-only -- NOT audited. */
export async function getShareSecurityUsers(deps: ClientDeps): Promise<readonly ShareSecurityUser[]> {
  return deps.client.readShareSecurityUsers();
}

/** Backs `Query.shareIsEmpty(name)`. Read-only -- NOT audited. An
 * empty/missing name defensively returns true so it never blocks the
 * Delete button on a bad query. */
export async function getShareIsEmpty(name: string, deps: ClientDeps): Promise<boolean> {
  if (!name || typeof name !== 'string') return true;
  return deps.client.isShareDirEmpty(name);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function pollForShare(
  client: EmhttpdClient,
  predicate: (share: ShareRecord) => boolean,
  maxMs: number,
): Promise<ShareRecord | undefined> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const shares = await client.getShares();
    const match = shares.find(predicate);
    if (match) return match;
    await delay(CREATE_POLL_STEP_MS);
  }
  return undefined;
}

/** Backs `Mutation.createShare(name, settings)`. Rejects a duplicate
 * name, sends `cmdEditShare=Add Share`, then polls the share list for the
 * new entry (the state-file watcher refresh races the mutation
 * completing) -- falling back to a synthetic entity built from the input
 * if the poll window elapses, since the .cfg IS on disk even if the
 * in-memory store hasn't caught up yet. */
export async function createShare(
  name: string,
  settings: ShareSettingsInput,
  deps: MutationDeps,
): Promise<ShareRecord> {
  validateShareName(name);

  const existingShares = await deps.client.getShares();
  if (existingShares.some((share) => share.name === name)) {
    throw new Error(`A share named "${name}" already exists.`);
  }

  const response = await deps.client.sendCommand({
    cmdEditShare: 'Add Share',
    shareName: name,
    shareNameOrig: '',
    ...buildShareCommands(settings),
  });
  if (isEmhttpdFailureResponse(response)) {
    throw new Error(`emhttpd refused createShare: ${response.trim().slice(0, 200)}`);
  }

  deps.audit.recordAuditEvent({
    action: 'shares.create',
    caller: deps.caller,
    target: name,
    outcome: 'initiated',
  });

  const created = await pollForShare(deps.client, (share) => share.name === name, CREATE_POLL_MAX_MS);
  if (created) return created;

  // The state file watcher hasn't picked up the new share yet -- the .cfg
  // is on disk, but the in-memory store is stale. Return a synthetic
  // entity built from the input so the client gets a useful response and
  // can refetch the shares list itself.
  return {
    id: name,
    name,
    comment: settings.comment != null ? String(settings.comment) : '',
    allocator: settings.allocator != null ? String(settings.allocator) : 'highwater',
    cow: settings.cow != null ? String(settings.cow) : 'auto',
    splitLevel: settings.splitLevel != null ? String(settings.splitLevel) : '',
    floor: settings.floor != null ? String(settings.floor) : '',
    useCache: settings.useCache != null ? String(settings.useCache) : '',
    include: Array.isArray(settings.include)
      ? settings.include.join(',')
      : typeof settings.include === 'string'
        ? settings.include
        : '',
    exclude: Array.isArray(settings.exclude)
      ? settings.exclude.join(',')
      : typeof settings.exclude === 'string'
        ? settings.exclude
        : '',
    size: 0,
    free: null,
    used: 0,
    cache: null,
    nameOrig: name,
    color: null,
    luksStatus: null,
    cachePool: settings.cachePool != null ? String(settings.cachePool) : '',
    cachePool2: settings.cachePool2 != null ? String(settings.cachePool2) : '',
  };
}

/** Backs `Mutation.updateShare(name, settings)`. Merges `settings` over
 * the CURRENT share's values (omitted keys keep their current value --
 * this is the server-side partial-update merge), sends
 * `cmdEditShare=Apply`, then waits a fixed settle delay before re-reading
 * the (best-effort) updated entity. */
export async function updateShare(
  name: string,
  settings: ShareSettingsInput,
  deps: MutationDeps,
): Promise<ShareRecord | undefined> {
  if (!name) {
    throw new Error('Share name is required.');
  }
  const shares = await deps.client.getShares();
  const current = shares.find((share) => share.name === name);
  if (!current) {
    throw new Error(`No share named "${name}".`);
  }

  const merged: ShareSettingsInput = {
    comment: current.comment,
    cachePool: current.cachePool,
    cachePool2: current.cachePool2,
    useCache: current.useCache,
    cow: current.cow,
    floor: current.floor,
    allocator: current.allocator,
    splitLevel: current.splitLevel,
    include: current.include,
    exclude: current.exclude,
    ...settings,
  };

  const response = await deps.client.sendCommand({
    cmdEditShare: 'Apply',
    shareName: name,
    shareNameOrig: name,
    ...buildShareCommands(merged),
  });
  if (isEmhttpdFailureResponse(response)) {
    throw new Error(`emhttpd refused updateShare: ${response.trim().slice(0, 200)}`);
  }

  deps.audit.recordAuditEvent({
    action: 'shares.update',
    caller: deps.caller,
    target: name,
    outcome: 'initiated',
  });

  await delay(UPDATE_SETTLE_DELAY_MS);
  const refreshed = await deps.client.getShares();
  return refreshed.find((share) => share.name === name);
}

/** Backs `Mutation.deleteShare(name)`. Checks `isShareDirEmpty` before
 * calling emhttpd so a non-empty share is rejected up front rather than
 * relying on emhttpd's own refusal as the only guard. */
export async function deleteShare(name: string, deps: MutationDeps): Promise<boolean> {
  if (!name) {
    throw new Error('Share name is required.');
  }
  const shares = await deps.client.getShares();
  const existing = shares.find((share) => share.name === name);
  if (!existing) {
    throw new Error(`No share named "${name}".`);
  }

  const isEmpty = await deps.client.isShareDirEmpty(name);
  if (!isEmpty) {
    throw new Error(`Share "${name}" is not empty. Remove its contents before deleting.`);
  }

  const response = await deps.client.sendCommand({
    cmdEditShare: 'Delete',
    confirmDelete: 'on',
    shareName: name,
    shareNameOrig: name,
  });
  if (isEmhttpdFailureResponse(response)) {
    throw new Error(`emhttpd refused deleteShare: ${response.trim().slice(0, 200)}`);
  }

  deps.audit.recordAuditEvent({
    action: 'shares.delete',
    caller: deps.caller,
    target: name,
    outcome: 'initiated',
  });

  return true;
}

/** Backs `Mutation.updateShareSecurity(name, settings)`. Sends
 * `changeShareSecurity=Apply` with the mapped fields, filling in
 * emhttpd's expected defaults for omitted keys. */
export async function updateShareSecurity(
  name: string,
  settings: ShareSecurityUpdateInput,
  deps: MutationDeps,
): Promise<boolean> {
  if (!name) {
    throw new Error('Share name is required.');
  }

  const response = await deps.client.sendCommand({
    changeShareSecurity: 'Apply',
    shareName: name,
    shareExport: settings.export != null ? String(settings.export) : '-',
    shareSecurity: settings.security != null ? String(settings.security) : 'public',
    shareCaseSensitive: settings.caseSensitive != null ? String(settings.caseSensitive) : 'auto',
    shareVolsizelimit: settings.volsizelimit != null ? String(settings.volsizelimit) : '',
  });
  if (isEmhttpdFailureResponse(response)) {
    throw new Error(`emhttpd refused updateShareSecurity: ${response.trim().slice(0, 200)}`);
  }

  deps.audit.recordAuditEvent({
    action: 'shares.updateSecurity',
    caller: deps.caller,
    target: name,
    outcome: 'initiated',
  });

  await delay(SECURITY_SETTLE_DELAY_MS);
  return true;
}

/** Backs `Mutation.updateShareAccess(name, access)`. Sends one
 * `userAccess.<id>=<value>` form field per `{userId, access}` entry,
 * defaulting a missing `access` value to `'no-access'` (fail-closed -- an
 * entry with no explicit grant never implicitly becomes read-write). */
export async function updateShareAccess(
  name: string,
  access: readonly ShareAccessEntry[],
  deps: MutationDeps,
): Promise<boolean> {
  if (!name) {
    throw new Error('Share name is required.');
  }
  if (!Array.isArray(access)) {
    throw new Error('access must be a list of {userId, access} entries.');
  }

  const payload: Record<string, string> = { changeShareAccess: 'Apply', shareName: name };
  for (const entry of access) {
    if (!entry || entry.userId == null) continue;
    payload[`userAccess.${String(entry.userId)}`] = String(entry.access || 'no-access');
  }

  const response = await deps.client.sendCommand(payload);
  if (isEmhttpdFailureResponse(response)) {
    throw new Error(`emhttpd refused updateShareAccess: ${response.trim().slice(0, 200)}`);
  }

  deps.audit.recordAuditEvent({
    action: 'shares.updateAccess',
    caller: deps.caller,
    target: name,
    outcome: 'initiated',
  });

  await delay(SECURITY_SETTLE_DELAY_MS);
  return true;
}
