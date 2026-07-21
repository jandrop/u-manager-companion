/**
 * updateDockerTemplate (streaming edit).
 *
 * Ported from `docker_template_edit.py`'s IIFE `start()`/`runUpdate()`
 * pipeline: stop the existing container, remove it, overwrite
 * my-<Name>.xml, pull ONLY if the image is missing locally (never a
 * stealth update -- `updateContainerStream` is the unconditional-pull
 * mutation), rebuild via rebuild_container. Deliberately does NOT call
 * `.start()` afterward: rebuild_container itself preserves autostart
 * behavior (stops the new container if the old one wasn't in Unraid's
 * autostart list), so calling start() unconditionally would resurrect a
 * container the user had intentionally stopped -- matching the Python
 * patch's explicit comment on this point.
 *
 * The PHP `xmlToCommand`/`buildDockerRunCommand` cosmetic log-decoration
 * step from the Python patch is NOT ported (see edit.test.ts's module doc
 * for the rationale) -- it reproduces a webgui log-formatting nicety with
 * no functional effect on the edit outcome.
 *
 * input.name MUST match the existing container name -- rename is not
 * supported in this mutation, matching the reference implementation.
 */
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
import { buildTemplateXml, sanitiseContainerName, type DockerTemplateXmlInput } from './xml.js';
import { DOCKER_INSTALL_CHANNEL_PREFIX, REBUILD_CONTAINER_CLI, TEMPLATES_USER_DIR } from './install.js';
import type { DockerInstallSubject } from './install.js';

export type DockerTemplateEditInput = DockerTemplateXmlInput & { readonly name: string };

/** Same injectable writer contract as install.ts -- shared so server.ts
 * wires ONE real implementation for both mutations. */
export type WriteTemplateFile = (name: string, xmlContent: string) => Promise<void>;

export interface EditDockerTemplateDeps {
  readonly dockerClient: DockerClient;
  readonly runRebuildContainer: StreamedProcessRunner;
  readonly writeTemplateFile: WriteTemplateFile;
  readonly audit: AuditLogger;
  readonly caller: AuditCaller;
}

function templatePath(name: string): string {
  return `${TEMPLATES_USER_DIR}/my-${name}.xml`;
}

async function stopContainer(
  operationId: string,
  name: string,
  dockerClient: DockerClient,
): Promise<void> {
  appendLine(operationId, `Stopping container: ${name}`);
  try {
    await dockerClient.getContainer(name).stop();
    appendLine(operationId, `Successfully stopped container '${name}'`);
  } catch (error) {
    if (isDockerApiError(error) && (error.statusCode === 304 || error.statusCode === 404)) {
      appendLine(operationId, `Container '${name}' already stopped`);
      return;
    }
    throw error;
  }
}

async function removeContainer(
  operationId: string,
  name: string,
  dockerClient: DockerClient,
): Promise<void> {
  appendLine(operationId, `Removing container: ${name}`);
  try {
    await dockerClient.getContainer(name).remove({ force: false, v: false });
    appendLine(operationId, `Successfully removed container '${name}'`);
  } catch (error) {
    if (isDockerApiError(error) && error.statusCode === 404) {
      appendLine(operationId, `Container '${name}' already removed`);
      return;
    }
    throw error;
  }
}

/** Pulls only when the image is NOT already present locally -- matches
 * Unraid's own Apply path so Edit never turns into a stealth update. */
async function pullImageIfMissing(
  operationId: string,
  repository: string,
  dockerClient: DockerClient,
): Promise<void> {
  if (!repository) return;
  try {
    await dockerClient.getImage(repository).inspect();
    return; // already present locally.
  } catch {
    // fall through to pull.
  }
  appendLine(operationId, `Pulling image ${repository}`);
  await dockerClient.pull(repository, (event) => {
    if (event.error) {
      appendLine(operationId, `Error: ${event.error}`);
      return;
    }
    if (!event.status) return;
    const layer = event.id ? `IMAGE ID [${event.id}]: ` : '';
    appendLine(operationId, `${layer}${event.status}`);
  });
}

async function rebuildContainer(
  operationId: string,
  name: string,
  runRebuildContainer: StreamedProcessRunner,
): Promise<void> {
  const result = await runRebuildContainer(
    REBUILD_CONTAINER_CLI,
    [encodeURIComponent(name)],
    (line) => appendLine(operationId, line),
  );
  if (result.exitCode !== 0) {
    throw new Error(`rebuild_container exited with code ${result.exitCode}`);
  }
}

async function runUpdate(
  operationId: string,
  input: DockerTemplateEditInput,
  name: string,
  deps: EditDockerTemplateDeps,
): Promise<void> {
  await stopContainer(operationId, name, deps.dockerClient);
  await removeContainer(operationId, name, deps.dockerClient);

  const xml = buildTemplateXml(input, name);
  await deps.writeTemplateFile(name, xml);
  appendLine(operationId, `Wrote template ${templatePath(name)}`);

  await pullImageIfMissing(operationId, input.repository, deps.dockerClient);
  await rebuildContainer(operationId, name, deps.runRebuildContainer);

  // Deliberately no start() call here -- see module doc.
  succeedOperation(operationId);
}

/**
 * Starts an async edit of an existing Docker container. Returns the
 * operation snapshot immediately (status=RUNNING); throws synchronously
 * (before any audit record or side effect) if the name fails sanitisation.
 */
export function editDockerTemplate(
  input: DockerTemplateEditInput,
  deps: EditDockerTemplateDeps,
): OperationSnapshot<DockerInstallSubject> {
  const containerName = sanitiseContainerName(input.name);

  const operation = createOperation<DockerInstallSubject>(DOCKER_INSTALL_CHANNEL_PREFIX, {
    containerName,
    repository: input.repository,
  });

  deps.audit.recordAuditEvent({
    action: 'docker.templateEdit',
    caller: deps.caller,
    target: containerName,
    outcome: 'initiated',
  });

  runUpdate(operation.id, input, containerName, deps).catch((error: unknown) => {
    failOperation(operation.id, error);
  });

  return operation;
}
