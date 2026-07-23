/**
 * Shares platform primitives + the injectable EmhttpdClient contract.
 *
 * Talks to emhttpd over its unix socket (form-encoded POST to
 * `/var/run/emhttpd.socket`, CSRF token read from
 * `/var/local/emhttp/var.ini`) and includes the failure-response check,
 * command-payload builder, and the `shareIsEmpty` recursive directory walk
 * under `/mnt/user/<name>`. Pure/testable helpers are exported directly;
 * `EmhttpdClient` is the higher-level injectable surface `resolvers.ts`
 * depends on -- production wiring (server.ts) builds the REAL client
 * (real socket + real ini/dir reads); tests inject a fake so nothing here
 * ever touches the real filesystem or a unix socket in a unit test.
 *
 * The emhttpd socket framing (HTTP/0.9-style response, no Content-Length)
 * and the `/var/local/emhttp/var.ini` CSRF format below have not been
 * independently verified against a live box. If either differs on a real
 * box, only this module's real-client factory (createEmhttpdClient, below)
 * needs to change; the ShareRecord/EmhttpdClient contract stays the same.
 */
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { readdir as fsReaddir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** Mirrors the field set the app's `ShareQuery`/`CreateShare`/`UpdateShare`
 * operations select (unraid_graphql_shares_queries.dart /
 * unraid_graphql_shares_mutations.dart), including the companion-added
 * `useCache`/`cachePool`/`cachePool2` extra fields. Numeric fields and
 * `include`/`exclude` are typed to match `ShareRemoteEntity` exactly
 * (int-valued sizes; `include`/`exclude` as a single delimited string --
 * the DTO's `_parseStringOrList` defensively also accepts a list, but the
 * SDL's `Share.include`/`exclude` are plain `String`, matching the native
 * field this type mirrors). */
export interface ShareRecord {
  readonly id: string;
  readonly name: string;
  readonly free: number | null;
  readonly used: number | null;
  readonly size: number | null;
  readonly include: string | null;
  readonly exclude: string | null;
  readonly cache: boolean | null;
  readonly useCache: string | null;
  readonly cachePool: string | null;
  readonly cachePool2: string | null;
  readonly nameOrig: string;
  readonly comment: string | null;
  readonly allocator: string | null;
  readonly splitLevel: string | null;
  readonly floor: string | null;
  readonly cow: string | null;
  readonly color: string | null;
  readonly luksStatus: number | null;
}

/** `settings` argument shape for createShare/updateShare (the `JSON`
 * scalar on the wire) -- every key optional, defaulting the same way
 * `buildShareCommands` does. `include`/`exclude` accept EITHER a caller-
 * supplied array (the mutation input shape) OR a plain string (the shape
 * `updateShare`'s current-value merge passes through from an existing
 * `Share.include`/`exclude`, which are scalar strings on the wire -- see
 * ShareRecord) -- a non-array, non-string value degrades to ''. */
export interface ShareSettingsInput {
  readonly comment?: string | null;
  readonly cachePool?: string | null;
  readonly cachePool2?: string | null;
  readonly useCache?: string | null;
  readonly cow?: string | null;
  readonly floor?: string | null;
  readonly allocator?: string | null;
  readonly splitLevel?: string | null;
  readonly include?: readonly string[] | string | null;
  readonly exclude?: readonly string[] | string | null;
}

/** Emhttpd `cmdEditShare`/`changeShareSecurity`/`changeShareAccess`
 * command payload -- always string-keyed, string-valued (form-encoded). */
export type EmhttpdCommands = Readonly<Record<string, string>>;

export interface ShareSecurity {
  readonly export: string;
  readonly security: string;
  readonly caseSensitive: string;
  readonly readList: readonly string[];
  readonly writeList: readonly string[];
  readonly volsizelimit: string;
}

export interface ShareSecurityUpdateInput {
  readonly export?: string | null;
  readonly security?: string | null;
  readonly caseSensitive?: string | null;
  readonly volsizelimit?: string | null;
}

export interface ShareSecurityUser {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly isRoot: boolean;
}

export interface ShareAccessEntry {
  readonly userId: string;
  readonly access: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without any IO)
// ---------------------------------------------------------------------------

/** Extracts `csrf_token` from `/var/local/emhttp/var.ini` content. Accepts
 * both the quoted (`csrf_token="abc"`) and unquoted forms the ini file may
 * carry. Returns '' when absent -- callers treat that as "unavailable". */
export function parseCsrfToken(varIniContent: string): string {
  const match = /^csrf_token=\"?([^\"\n]+)\"?/m.exec(varIniContent);
  return match?.[1] ?? '';
}

/** True when the emhttpd response body is an error rather than the
 * success payload. Success bodies look like
 * `<script>replaceName("name");</script>`; failure bodies are bare
 * strings such as `500 Internal Server Error` or a partial HTTP/1.1
 * frame whose body contains the error text. */
export function isEmhttpdFailureResponse(body: string): boolean {
  if (!body) return false;
  if (/<script\b/i.test(body)) return false;
  return /^\s*500\b|Internal Server Error|Bad Request|Unauthorized|Forbidden/i.test(body);
}

/** Normalises an `include`/`exclude` value to the comma-separated string
 * emhttpd expects: an array joins with ','; a plain string (the
 * current-value merge case) passes through unchanged; anything else
 * (defensive) degrades to ''. The string passthrough matters because
 * `updateShare`'s current-value merge passes `ShareRecord.include/exclude`
 * back in as scalar strings -- without it, an unrelated field's update
 * would silently clear include/exclude. */
function normaliseIncludeExclude(value: readonly string[] | string | null | undefined): string {
  if (Array.isArray(value)) return value.join(',');
  if (typeof value === 'string') return value;
  return '';
}

/** Maps a ShareSettingsInput to the emhttpd `cmdEditShare` command payload,
 * filling in emhttpd's expected defaults for omitted fields. */
export function buildShareCommands(settings: ShareSettingsInput): EmhttpdCommands {
  return {
    shareComment: settings.comment != null ? String(settings.comment) : '',
    shareCachePool: settings.cachePool != null ? String(settings.cachePool) : '',
    shareCachePool2: settings.cachePool2 != null ? String(settings.cachePool2) : '',
    shareUseCache: settings.useCache != null ? String(settings.useCache) : '',
    shareCOW: settings.cow != null ? String(settings.cow) : 'auto',
    shareFloor: settings.floor != null ? String(settings.floor) : '',
    shareAllocator: settings.allocator != null ? String(settings.allocator) : 'highwater',
    shareSplitLevel: settings.splitLevel != null ? String(settings.splitLevel) : '',
    shareInclude: normaliseIncludeExclude(settings.include),
    shareExclude: normaliseIncludeExclude(settings.exclude),
  };
}

/** Injectable directory-entry surface for scanShareDirEmpty -- production
 * wiring shells to fs/promises; tests inject a fake so nothing here
 * touches a real filesystem. Matches the Dirent shape scanShareDirEmpty
 * actually needs (name + kind checks), not the full fs.Dirent contract. */
export interface ShareDirEntryLike {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ScanShareDirDeps {
  readonly readdir: (directory: string) => Promise<readonly ShareDirEntryLike[]>;
  readonly stat: (entryPath: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

/**
 * Walks `directory` recursively and returns true when nothing user-visible
 * lives inside: directories alone don't count, `.DS_Store` is ignored,
 * symlinks are followed, and the walk stops at the first real file
 * (short-circuit). An unreadable directory resolves to true so a
 * transient IO error never blocks the Delete button.
 */
export async function scanShareDirEmpty(
  directory: string,
  deps: ScanShareDirDeps,
): Promise<boolean> {
  let entries: readonly ShareDirEntryLike[];
  try {
    entries = await deps.readdir(directory);
  } catch {
    return true;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stats = await deps.stat(entryPath);
        isDir = stats.isDirectory();
        isFile = stats.isFile();
      } catch {
        continue;
      }
    }
    if (isFile && entry.name !== '.DS_Store') return false;
    if (isDir) {
      const childEmpty = await scanShareDirEmpty(entryPath, deps);
      if (!childEmpty) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// EmhttpdClient -- the injectable surface resolvers.ts depends on
// ---------------------------------------------------------------------------

export interface EmhttpdClient {
  /** Current share list, sourced from shares.ini (in-memory store). */
  getShares(): Promise<readonly ShareRecord[]>;
  /** Sends a form-encoded command payload to emhttpd, returning the raw
   * response body. Throws on transport failure (socket error/timeout);
   * an application-level failure is signalled in the BODY text and
   * detected via isEmhttpdFailureResponse -- this method does not throw
   * for that case. */
  sendCommand(commands: EmhttpdCommands): Promise<string>;
  /** Reads the current SMB security blob for a share from sec.ini. */
  readShareSecurity(name: string): Promise<ShareSecurity>;
  /** Reads the list of Unraid users from users.ini. */
  readShareSecurityUsers(): Promise<readonly ShareSecurityUser[]>;
  /** True when `/mnt/user/<name>` holds no user-visible files. */
  isShareDirEmpty(name: string): Promise<boolean>;
}

const EMHTTPD_SOCKET_PATH = '/var/run/emhttpd.socket';
const VAR_INI_PATH = '/var/local/emhttp/var.ini';
const SEC_INI_PATH = '/usr/local/emhttp/state/sec.ini';
const USERS_INI_PATH = '/usr/local/emhttp/state/users.ini';
const SHARES_MOUNT_ROOT = '/mnt/user';
/** Comfortable ceiling for every emhttpd command this module sends --
 * `cmdEditShare=Add Share`/`=Delete` respond fast but `=Apply` (update)
 * can sit on the connection for ~12s before headers arrive. */
const EMHTTPD_SOCKET_TIMEOUT_MS = 30_000;
/** Debounce window after the last data chunk before declaring the emhttpd
 * response "done" -- some response bodies arrive in two fragments and
 * there is no Content-Length/chunked marker to detect EOF otherwise. */
const EMHTTPD_RESPONSE_IDLE_MS = 200;

async function readCsrfToken(): Promise<string> {
  try {
    const content = await readFile(VAR_INI_PATH, 'utf8');
    return parseCsrfToken(content);
  } catch {
    return '';
  }
}

/** Sends a form-encoded POST to `/var/run/emhttpd.socket` and returns the
 * raw response body. emhttpd replies with HTTP/0.9 on success (just the
 * body, no status line) and a partial HTTP/1.1 frame on error, so this
 * bypasses Node's http parser and reads bytes directly off the socket.
 * `cmdEditShare=Delete` returns an empty body without closing the socket,
 * so it blocks until EMHTTPD_SOCKET_TIMEOUT_MS -- the real delete
 * completes server-side in ~20s, emhttpd just never signals EOF for it,
 * so the caller has to wait out the full 30s timeout. */
async function callEmhttpd(commands: EmhttpdCommands): Promise<string> {
  const csrf = await readCsrfToken();
  if (!csrf) {
    throw new Error('CSRF token unavailable. Is /var/local/emhttp/var.ini readable?');
  }
  const body = new URLSearchParams({ ...commands, csrf_token: csrf }).toString();
  const request =
    'POST /update HTTP/1.1\r\n' +
    'Host: localhost\r\n' +
    'Content-Type: application/x-www-form-urlencoded\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n' +
    '\r\n' +
    body;

  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(EMHTTPD_SOCKET_PATH);
    const chunks: Buffer[] = [];
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;

    const settle = (ok: boolean, payload: string | Error): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      try {
        socket.destroy();
      } catch {
        // best-effort close.
      }
      if (ok) resolve(payload as string);
      else reject(payload as Error);
    };

    socket.setTimeout(EMHTTPD_SOCKET_TIMEOUT_MS);
    socket.on('connect', () => {
      socket.end(request);
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => settle(true, Buffer.concat(chunks).toString('utf8')),
        EMHTTPD_RESPONSE_IDLE_MS,
      );
    });
    socket.on('end', () => settle(true, Buffer.concat(chunks).toString('utf8')));
    socket.on('timeout', () => settle(false, new Error('emhttpd socket timeout')));
    socket.on('error', (err) => settle(false, err));
  });
}

/** Minimal INI parser sufficient for sec.ini/users.ini's flat
 * `[section]\nkey=value` shape (values may be quoted), not yet verified
 * against a real file on a live box. A parse failure for either file
 * degrades to an empty result rather than throwing. */
function parseIni(content: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let currentSection: string | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = /^\[(.+)\]$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1] ?? null;
      if (currentSection && !(currentSection in result)) result[currentSection] = {};
      continue;
    }
    const kvMatch = /^([^=]+)=(.*)$/.exec(line);
    if (!kvMatch || currentSection === null) continue;
    const key = kvMatch[1]!.trim();
    const value = kvMatch[2]!.trim().replace(/^"(.*)"$/, '$1');
    result[currentSection]![key] = value;
  }
  return result;
}

/**
 * Parses `/usr/local/emhttp/state/shares.ini` into ShareRecord[]. Section
 * headers use emhttp's quoted-name convention (`["media"]`), unlike
 * sec.ini/users.ini's plain `[section]` -- parseIni's section regex only
 * matches the unquoted form, so this has its own small section-splitting
 * pass rather than reusing parseIni directly.
 *
 * unraid-api parses this file internally and we don't shell into its
 * bundle to reuse that parser, so this is a standalone reimplementation.
 * Key names below are inferred from the companion's own field surface
 * (the CreateShare/UpdateShare Share field set) -- worth confirming
 * against a real shares.ini on first live-box verification.
 */
export function parseSharesIni(content: string): readonly ShareRecord[] {
  const sections: { name: string; fields: Record<string, string> }[] = [];
  let current: { name: string; fields: Record<string, string> } | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = /^\[\"?([^"[\]]+)\"?\]$/.exec(line);
    if (sectionMatch) {
      current = { name: sectionMatch[1] ?? '', fields: {} };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const kvMatch = /^([^=]+)=(.*)$/.exec(line);
    if (!kvMatch) continue;
    const key = kvMatch[1]!.trim();
    const value = kvMatch[2]!.trim().replace(/^"(.*)"$/, '$1');
    current.fields[key] = value;
  }

  return sections.map(({ name, fields }) => {
    const useCache = fields['useCache'] ?? null;
    return {
      id: name,
      name,
      free: parseNumericField(fields['free']),
      used: parseNumericField(fields['used']),
      size: parseNumericField(fields['size']),
      include: fields['include'] ?? '',
      exclude: fields['exclude'] ?? '',
      cache: useCache ? useCache === 'yes' : null,
      useCache: useCache || null,
      cachePool: fields['cachePool'] ?? '',
      cachePool2: fields['cachePool2'] ?? '',
      nameOrig: fields['nameOrig'] || name,
      comment: fields['comment'] ?? '',
      allocator: fields['allocator'] ?? '',
      splitLevel: fields['splitLevel'] ?? '',
      floor: fields['floor'] ?? '',
      cow: fields['cow'] ?? '',
      color: fields['color'] ?? '',
      luksStatus: parseNumericField(fields['luksStatus']),
    };
  });
}

function parseNumericField(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const SHARES_INI_PATH = '/usr/local/emhttp/state/shares.ini';

/** Reads and parses the real shares.ini. A missing/unreadable file
 * degrades to an empty list rather than throwing (matches every other
 * best-effort ini read in this module). */
async function readSharesFromIniReal(): Promise<readonly ShareRecord[]> {
  try {
    const content = await readFile(SHARES_INI_PATH, 'utf8');
    return parseSharesIni(content);
  } catch {
    return [];
  }
}

async function readShareSecurityReal(name: string): Promise<ShareSecurity> {
  try {
    const content = await readFile(SEC_INI_PATH, 'utf8');
    const parsed = parseIni(content);
    const sec = parsed[name] ?? {};
    return {
      export: sec['export'] || '-',
      security: sec['security'] || 'public',
      caseSensitive: sec['caseSensitive'] || 'auto',
      readList: sec['readList'] ? sec['readList'].split(',').filter(Boolean) : [],
      writeList: sec['writeList'] ? sec['writeList'].split(',').filter(Boolean) : [],
      volsizelimit: sec['volsizelimit'] ?? '',
    };
  } catch {
    return { export: '-', security: 'public', caseSensitive: 'auto', readList: [], writeList: [], volsizelimit: '' };
  }
}

async function readShareSecurityUsersReal(): Promise<readonly ShareSecurityUser[]> {
  try {
    const content = await readFile(USERS_INI_PATH, 'utf8');
    const parsed = parseIni(content);
    return Object.entries(parsed).map(([key, data]) => ({
      id: data['idx'] ?? key,
      name: data['name'] || key,
      description: data['desc'] ?? '',
      isRoot: (data['name'] || key) === 'root',
    }));
  } catch {
    return [];
  }
}

/**
 * Builds the REAL EmhttpdClient -- real unix socket + real ini/dir reads.
 * `getShares` defaults to `readSharesFromIniReal` (native shares.ini
 * parse, §parseSharesIni) but stays overridable so server.ts can supply
 * an alternative share-listing source without this module needing to
 * change if the real shares data source ever moves.
 */
export function createEmhttpdClient(
  getShares: () => Promise<readonly ShareRecord[]> = readSharesFromIniReal,
): EmhttpdClient {
  return {
    getShares,
    sendCommand: callEmhttpd,
    readShareSecurity: readShareSecurityReal,
    readShareSecurityUsers: readShareSecurityUsersReal,
    async isShareDirEmpty(name: string): Promise<boolean> {
      if (!name) return true;
      return scanShareDirEmpty(path.join(SHARES_MOUNT_ROOT, name), {
        readdir: (dir) => fsReaddir(dir, { withFileTypes: true }),
        stat: fsStat,
      });
    },
  };
}
