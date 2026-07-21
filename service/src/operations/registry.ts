/**
 * Streaming-operation registry.
 *
 * Direct TypeScript port of the proven in-bundle IIFE state machine in
 * `docker_template_create.py` (PATCH_MARKER "docker-install-stream-v2"):
 * same `Map<id, Operation>` store, same ring-buffer cap (drop-oldest), same
 * QUEUED/RUNNING/SUCCEEDED/FAILED status transitions, same delta-only
 * publish-per-append semantics, same unref'd-timer TTL cleanup, same
 * snapshot-returns-null-after-cleanup contract. Kept feature-agnostic (no
 * Docker-specific fields) so every streaming feature (docker install/update,
 * plugin install/uninstall) shares one engine instead of re-deriving the
 * state machine per feature module ("no feature imports
 * another feature" -- feature modules import this registry, not each other).
 */
import { randomUUID } from 'node:crypto';
import { channelFor, pubsub } from '../pubsub';

/** Lifecycle status shared by every streaming operation (mirrors schema.graphql's DockerInstallStatus). */
export type OperationStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

/**
 * Per-operation output cap. Ported verbatim from docker_template_create.py's
 * `MAX_OUTPUT_LINES = 500` -- oldest lines are dropped once exceeded, so a
 * long-running operation's snapshot never grows unbounded.
 */
export const MAX_OUTPUT_LINES = 500;

/**
 * Completed-operation retention window before cleanup, in milliseconds.
 * Ported verbatim from docker_template_create.py's `COMPLETED_TTL_MS =
 * 15 * 60 * 1000` -- gives reconnecting clients a snapshot window after
 * backgrounding, without operations accumulating forever.
 */
export const TTL_MS = 15 * 60 * 1000;

/** Immutable snapshot returned to callers -- never the live internal record. */
export interface OperationSnapshot<TSubject = unknown> {
  readonly id: string;
  readonly channelPrefix: string;
  readonly subject: TSubject;
  readonly status: OperationStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly finishedAt: Date | null;
  readonly output: readonly string[];
}

/** Live internal record. Never returned directly -- getSnapshot() always defensive-copies. */
interface OperationRecord<TSubject = unknown> {
  id: string;
  channelPrefix: string;
  subject: TSubject;
  status: OperationStatus;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  output: string[];
}

/** Delta event payload published on `channelFor(channelPrefix, id)`. Mirrors DockerInstallEvent in schema.graphql. */
export interface OperationDeltaEvent {
  readonly operationId: string;
  readonly status: OperationStatus;
  readonly output?: readonly string[];
  readonly timestamp: Date;
}

const operations = new Map<string, OperationRecord>();
const cleanupTimers = new Map<string, NodeJS.Timeout>();

/**
 * Registers a new operation and returns its id-bearing record. Status
 * defaults to RUNNING (the common case: a mutation starts work immediately)
 * but callers can pass QUEUED when work is only enqueued, not yet started.
 */
export function createOperation<TSubject>(
  channelPrefix: string,
  subject: TSubject,
  status: OperationStatus = 'RUNNING',
): OperationSnapshot<TSubject> {
  const id = randomUUID();
  const createdAt = new Date();
  const record: OperationRecord<TSubject> = {
    id,
    channelPrefix,
    subject,
    status,
    createdAt,
    updatedAt: createdAt,
    finishedAt: null,
    output: [],
  };
  operations.set(id, record as OperationRecord);
  return toSnapshot(record);
}

/** Returns a defensive-copy snapshot, or null if the operation is unknown or has been cleaned up. */
export function getSnapshot<TSubject = unknown>(id: string): OperationSnapshot<TSubject> | null {
  const record = operations.get(id);
  return record ? toSnapshot(record as OperationRecord<TSubject>) : null;
}

/**
 * Appends one output line to an operation's ring buffer, trims to
 * MAX_OUTPUT_LINES (drop-oldest), stamps updatedAt, and publishes a
 * delta event carrying ONLY this line -- never the cumulative buffer.
 * No-op if the operation is unknown (e.g. already cleaned up).
 */
export function appendLine(id: string, line: string): void {
  const record = operations.get(id);
  if (!record) return;
  record.updatedAt = new Date();
  record.output.push(line);
  trimOutput(record);
  publishEvent(record, [line]);
}

/**
 * Transitions RUNNING -> SUCCEEDED, stamps finishedAt/updatedAt, publishes a
 * status-only event (no output field), and schedules TTL cleanup. No-op if
 * the operation is unknown or already in a terminal state (SUCCEEDED/FAILED)
 * -- matches the reference implementation's `if (op.status !== 'RUNNING')
 * return;` guard, so a late completion signal can never override an
 * already-terminal outcome.
 */
export function succeedOperation(id: string): void {
  const record = operations.get(id);
  if (!record || record.status !== 'RUNNING') return;
  record.status = 'SUCCEEDED';
  record.finishedAt = new Date();
  record.updatedAt = record.finishedAt;
  publishEvent(record, []);
  scheduleCleanup(id);
}

/**
 * Transitions RUNNING -> FAILED, stamps finishedAt/updatedAt, appends an
 * `Error: <message>` line to the output buffer, publishes a delta event
 * carrying that line, and schedules TTL cleanup. Same terminal-state guard
 * as succeedOperation.
 */
export function failOperation(id: string, error: unknown): void {
  const record = operations.get(id);
  if (!record || record.status !== 'RUNNING') return;
  record.status = 'FAILED';
  record.finishedAt = new Date();
  record.updatedAt = record.finishedAt;
  const line = `Error: ${error instanceof Error ? error.message : String(error)}`;
  record.output.push(line);
  trimOutput(record);
  publishEvent(record, [line]);
  scheduleCleanup(id);
}

function trimOutput(record: OperationRecord): void {
  if (record.output.length > MAX_OUTPUT_LINES) {
    record.output.splice(0, record.output.length - MAX_OUTPUT_LINES);
  }
}

function publishEvent(record: OperationRecord, deltaLines: readonly string[]): void {
  const event: OperationDeltaEvent = {
    operationId: record.id,
    status: record.status,
    timestamp: new Date(),
    // exactOptionalPropertyTypes: true forbids assigning `undefined` to an
    // optional property directly -- omit the key entirely (status-only
    // events, e.g. succeedOperation) instead of setting it to undefined.
    ...(deltaLines.length ? { output: deltaLines } : {}),
  };
  // Best-effort: a publish failure (e.g. no active subscribers) must never
  // fail the caller's mutation/feature-module work. Mirrors the reference
  // implementation's try/catch around pubsub.publish.
  void pubsub.publish(channelFor(record.channelPrefix, record.id), event).catch(() => {
    /* best-effort */
  });
}

/**
 * Schedules operation deletion after TTL_MS. Uses an unref'd timer so a
 * pending cleanup never keeps the Node process alive on its own -- matches
 * the reference implementation's `if (typeof timer.unref === 'function')
 * timer.unref();`. Replaces any previously scheduled cleanup for the same
 * id (defensive; the terminal-state guards on succeed/failOperation mean
 * this should only ever fire once per operation in practice).
 */
function scheduleCleanup(id: string): void {
  const existing = cleanupTimers.get(id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    operations.delete(id);
    cleanupTimers.delete(id);
  }, TTL_MS);
  timer.unref?.();
  cleanupTimers.set(id, timer);
}

function toSnapshot<TSubject>(record: OperationRecord<TSubject>): OperationSnapshot<TSubject> {
  return {
    id: record.id,
    channelPrefix: record.channelPrefix,
    subject: record.subject,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    finishedAt: record.finishedAt,
    // Defensive copy -- callers must never be able to mutate internal state
    // through a returned snapshot.
    output: [...record.output],
  };
}
