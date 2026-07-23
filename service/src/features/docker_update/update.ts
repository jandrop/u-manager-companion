/**
 * updateContainerStream + updateAllContainersStream.
 *
 * Per-container pipeline: pull image, stop-if-running, remove,
 * `rebuild_container`, restart ONLY if the container was running before
 * AND rebuild_container did not already auto-restart it (checked via a
 * post-rebuild inspect diff), best-effort orphan-image removal.
 * Update-all resolves updatable targets via an injected lookup
 * (production wiring reads `/var/lib/docker/unraid-update-status.json`
 * and matches against running containers) and runs the per-container
 * pipeline SEQUENTIALLY under one operation, aggregating output across
 * every target. Concurrency: a module-level `busy` flag refuses to start
 * a new update while one is in flight (install/edit ops are independent
 * and NOT gated by this; only update ops share this serialization).
 *
 * `syncUpdateStatusForRepo()` rewrites unraid-update-status.json and the
 * docker.json webui-info cache -- without it the update pipeline
 * recreates the container but leaves Unraid's on-disk update-status
 * caches stale, so the "update available" badge never clears even though
 * the container was updated. Runs after a successful rebuild for both
 * single-container and update-all (called from inside `updateOne`, so
 * update-all gets it for free per target).
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  appendLine,
  createOperation,
  failOperation,
  succeedOperation,
  type OperationSnapshot,
} from '../../operations/registry.js';
import type { AuditCaller, AuditLogger } from '../../audit.js';
import { isDockerApiError, type DockerClient } from '../../platform/docker-client.js';
import type { StreamedProcessRunner } from '../../platform/process-runner.js';
import { REBUILD_CONTAINER_CLI } from '../docker_template/install.js';
import type { DockerInstallSubject } from '../docker_template/install.js';

export const DOCKER_INSTALL_CHANNEL_PREFIX = 'DOCKER_INSTALL';

/** Injectable resolver for "every container with an available update".
 * Production wiring reads `/var/lib/docker/unraid-update-status.json`
 * (local!=remote digest pairs) and cross-references running containers;
 * tests inject a fake list directly. */
export type ListUpdatableContainerNames = () => Promise<readonly string[]>;

export interface DockerUpdateDeps {
  readonly dockerClient: DockerClient;
  readonly runRebuildContainer: StreamedProcessRunner;
  readonly audit: AuditLogger;
  readonly caller: AuditCaller;
  /** Path to Unraid's update-status cache (local!=remote digest pairs) --
   * syncUpdateStatusForRepo() rewrites the updated repo's entry here after
   * a successful update. Config-driven (platform/config.ts's
   * `dockerUpdateStatusPath`) so tests can point it at a temp file. */
  readonly updateStatusPath: string;
  /** Path to Unraid webui's per-container docker-info cache --
   * syncUpdateStatusForRepo() sets `[name].updated = 'true'` here so the
   * webui badge clears without waiting for a full getAllInfo() reload.
   * Config-driven (platform/config.ts's `dockerWebuiInfoPath`). */
  readonly dockerWebuiInfoPath: string;
}

export interface DockerUpdateAllDeps extends DockerUpdateDeps {
  readonly listUpdatableContainerNames: ListUpdatableContainerNames;
}

// Module-level busy flag: update ops (single or all) refuse to overlap;
// install/edit ops are unaffected.
let busy = false;

/** Test-only reset -- each test file gets a clean module under vitest's
 * per-file module isolation already, but within a single file successive
 * `it()`s share this module-level flag, so tests reset it explicitly. */
export function __resetUpdateBusyForTests(): void {
  busy = false;
}

async function rebuildContainer(
  operationId: string,
  name: string,
  runRebuildContainer: StreamedProcessRunner,
): Promise<void> {
  appendLine(operationId, `Running rebuild_container ${name}`);
  const result = await runRebuildContainer(
    REBUILD_CONTAINER_CLI,
    [encodeURIComponent(name)],
    (line) => appendLine(operationId, line),
  );
  if (result.exitCode !== 0) {
    throw new Error(`rebuild_container exited with code ${result.exitCode}`);
  }
}

async function pullImage(operationId: string, repository: string, dockerClient: DockerClient): Promise<void> {
  if (!repository) return;
  const tagged = /:\S+$/.test(repository) ? repository : `${repository}:latest`;
  appendLine(operationId, `Pulling image ${tagged}`);
  await dockerClient.pull(tagged, (event) => {
    if (event.error) {
      appendLine(operationId, `Error: ${event.error}`);
      return;
    }
    if (!event.status) return;
    const layer = event.id ? `IMAGE ID [${event.id}]: ` : '';
    appendLine(operationId, `${layer}${event.status}`);
  });
}

async function stopContainer(operationId: string, name: string, dockerClient: DockerClient): Promise<void> {
  appendLine(operationId, `Stopping container ${name}`);
  try {
    await dockerClient.getContainer(name).stop();
    appendLine(operationId, `Stopped ${name}`);
  } catch (error) {
    if (isDockerApiError(error) && (error.statusCode === 304 || error.statusCode === 404)) {
      appendLine(operationId, `Container ${name} already stopped`);
      return;
    }
    throw error;
  }
}

async function removeContainer(operationId: string, name: string, dockerClient: DockerClient): Promise<void> {
  appendLine(operationId, `Removing container ${name}`);
  try {
    await dockerClient.getContainer(name).remove({ force: false, v: false });
    appendLine(operationId, `Removed ${name}`);
  } catch (error) {
    if (isDockerApiError(error) && error.statusCode === 404) {
      appendLine(operationId, `Container ${name} already removed`);
      return;
    }
    throw error;
  }
}

async function startContainer(operationId: string, name: string, dockerClient: DockerClient): Promise<void> {
  appendLine(operationId, `Starting container ${name}`);
  try {
    await dockerClient.getContainer(name).start();
    appendLine(operationId, `Container ${name} started`);
  } catch (error) {
    if (isDockerApiError(error) && error.statusCode === 304) {
      appendLine(operationId, `Container ${name} already running`);
      return;
    }
    throw error;
  }
}

async function removeOldImageBestEffort(
  operationId: string,
  oldImageId: string | undefined,
  newImageId: string | undefined,
  dockerClient: DockerClient,
): Promise<void> {
  if (!oldImageId || oldImageId === newImageId) return;
  try {
    await dockerClient.getImage(oldImageId).remove({ force: false });
    appendLine(operationId, `Removed orphan image ${oldImageId}`);
  } catch {
    /* best-effort -- likely still referenced */
  }
}

interface ContainerSnapshot {
  readonly name: string;
  readonly repository: string;
  readonly wasRunning: boolean;
  readonly imageId: string;
}

interface UpdateStatusEntry {
  local: string;
  remote: string;
  status: string;
}

/** Reads a JSON cache file, tolerating a missing/malformed file by falling
 * back to `{}` -- a cache file that doesn't exist yet just means "nothing
 * cached". */
async function readJsonObjectOrEmpty(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function writeJsonObject(filePath: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 4)}\n`, { encoding: 'utf8', mode: 0o644 });
}

/**
 * Refreshes Unraid's on-disk update-status caches for one repository/
 * container pair after a successful update. Without this the update
 * pipeline recreates the container but the "update available" badge
 * never clears, because both caches below are read/short-circuited
 * independently of whether the container was actually rebuilt.
 *
 * 1. Inspects the (now up to date) image to get its current digest.
 * 2. Sets `updateStatusPath[tagged] = { local, remote, status: 'true' }` --
 *    `status:'true'` means up-to-date in this file's own convention.
 * 3. Sets `dockerWebuiInfoPath[name].updated = 'true'` so the webui's
 *    cached per-container info also reflects the update immediately.
 *
 * Best-effort: any failure here is non-fatal to the update itself (the
 * container was still successfully rebuilt) -- logged to the operation
 * output instead of thrown.
 */
async function syncUpdateStatusForRepo(
  operationId: string,
  dockerClient: DockerClient,
  name: string,
  repository: string,
  updateStatusPath: string,
  dockerWebuiInfoPath: string,
): Promise<void> {
  if (!repository) return;
  try {
    const tagged = /:\S+$/.test(repository) ? repository : `${repository}:latest`;
    const inspected = await dockerClient.getImage(tagged).inspect();
    const repoDigests = inspected.RepoDigests ?? [];
    const first = repoDigests[0];
    if (!first) return;
    const atIndex = first.indexOf('@');
    const digest = atIndex >= 0 ? first.slice(atIndex + 1) : first;
    if (!digest) return;

    const updateStatus = await readJsonObjectOrEmpty(updateStatusPath);
    updateStatus[tagged] = { local: digest, remote: digest, status: 'true' } satisfies UpdateStatusEntry;
    await writeJsonObject(updateStatusPath, updateStatus);

    const webuiInfo = await readJsonObjectOrEmpty(dockerWebuiInfoPath);
    const existingEntry = webuiInfo[name];
    const entry: Record<string, unknown> =
      existingEntry && typeof existingEntry === 'object' ? { ...existingEntry } : {};
    entry['updated'] = 'true';
    webuiInfo[name] = entry;
    await writeJsonObject(dockerWebuiInfoPath, webuiInfo);
  } catch (error) {
    appendLine(
      operationId,
      `Could not sync update-status: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function inspectContainer(idOrName: string, dockerClient: DockerClient): Promise<ContainerSnapshot> {
  const inspected = await dockerClient.getContainer(idOrName).inspect();
  const name = inspected.Name.replace(/^\//, '') || idOrName;
  return {
    name,
    repository: inspected.Config.Image,
    wasRunning: inspected.State.Running,
    imageId: inspected.Image,
  };
}

async function updateOne(
  operationId: string,
  idOrName: string,
  dockerClient: DockerClient,
  runRebuildContainer: StreamedProcessRunner,
  updateStatusPath: string,
  dockerWebuiInfoPath: string,
): Promise<void> {
  const before = await inspectContainer(idOrName, dockerClient);
  appendLine(operationId, `── Updating ${before.name} ──`);
  await pullImage(operationId, before.repository, dockerClient);
  if (before.wasRunning) await stopContainer(operationId, before.name, dockerClient);
  await removeContainer(operationId, before.name, dockerClient);
  await rebuildContainer(operationId, before.name, runRebuildContainer);

  try {
    const after = await inspectContainer(before.name, dockerClient);
    if (before.wasRunning && !after.wasRunning) {
      await startContainer(operationId, before.name, dockerClient);
    }
    await removeOldImageBestEffort(operationId, before.imageId, after.imageId, dockerClient);
  } catch (error) {
    // Post-update inspect failure is non-fatal -- the pull + rebuild
    // output above already reached the user.
    appendLine(
      operationId,
      `Post-update inspect failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Only after a successful rebuild -- refresh Unraid's on-disk
  // update-status caches so the "update available" badge clears. Runs for
  // BOTH single update and update-all, since both call updateOne().
  await syncUpdateStatusForRepo(
    operationId,
    dockerClient,
    before.name,
    before.repository,
    updateStatusPath,
    dockerWebuiInfoPath,
  );
}

function newSubject(containerName: string, repository: string): DockerInstallSubject {
  return { containerName, repository };
}

async function runSingleUpdate(
  operationId: string,
  idOrName: string,
  deps: DockerUpdateDeps,
): Promise<void> {
  await updateOne(
    operationId,
    idOrName,
    deps.dockerClient,
    deps.runRebuildContainer,
    deps.updateStatusPath,
    deps.dockerWebuiInfoPath,
  );
  succeedOperation(operationId);
}

async function runUpdateAll(operationId: string, deps: DockerUpdateAllDeps): Promise<void> {
  const targets = await deps.listUpdatableContainerNames();
  if (targets.length === 0) {
    appendLine(operationId, 'No containers with available updates.');
    succeedOperation(operationId);
    return;
  }
  appendLine(operationId, `Updating ${targets.length} container(s): ${targets.join(', ')}`);
  const failed: string[] = [];
  for (const name of targets) {
    try {
      await updateOne(
        operationId,
        name,
        deps.dockerClient,
        deps.runRebuildContainer,
        deps.updateStatusPath,
        deps.dockerWebuiInfoPath,
      );
    } catch (error) {
      failed.push(name);
      appendLine(operationId, `Error updating ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed.length > 0) {
    failOperation(operationId, new Error(`Failed to update: ${failed.join(', ')}`));
    return;
  }
  succeedOperation(operationId);
}

/**
 * Starts an async update of a single Docker container. Throws
 * synchronously if another update (single or all) is already in flight.
 */
export function updateContainerStream(
  idOrName: string,
  deps: DockerUpdateDeps,
): OperationSnapshot<DockerInstallSubject> {
  if (busy) throw new Error('Another Docker update is already in progress');
  busy = true;

  const operation = createOperation<DockerInstallSubject>(
    DOCKER_INSTALL_CHANNEL_PREFIX,
    newSubject(idOrName, ''),
  );

  deps.audit.recordAuditEvent({
    action: 'docker.updateStream',
    caller: deps.caller,
    target: idOrName,
    outcome: 'initiated',
  });

  runSingleUpdate(operation.id, idOrName, deps)
    .catch((error: unknown) => failOperation(operation.id, error))
    .finally(() => {
      busy = false;
    });

  return operation;
}

/**
 * Starts an async update of every Docker container with an available
 * update. Throws synchronously if another update is already in flight.
 */
export function updateAllContainersStream(
  deps: DockerUpdateAllDeps,
): OperationSnapshot<DockerInstallSubject> {
  if (busy) throw new Error('Another Docker update is already in progress');
  busy = true;

  const operation = createOperation<DockerInstallSubject>(
    DOCKER_INSTALL_CHANNEL_PREFIX,
    newSubject('All updatable containers', '*'),
  );

  deps.audit.recordAuditEvent({
    action: 'docker.updateStream',
    caller: deps.caller,
    target: 'All updatable containers',
    outcome: 'initiated',
  });

  runUpdateAll(operation.id, deps)
    .catch((error: unknown) => failOperation(operation.id, error))
    .finally(() => {
      busy = false;
    });

  return operation;
}
