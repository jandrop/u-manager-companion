/**
 * installDockerTemplate (streaming).
 *
 * Direct TypeScript port of `docker_template_create.py`'s IIFE `start()`/
 * `runInstall()` pipeline, retargeted at this service's operation registry
 * (operations/registry.ts) instead of the bundle-local Map/pubsub pair:
 *
 *   1. write `my-<Name>.xml` to templates-user (xml.ts's buildTemplateXml).
 *   2. pull the image via the injected DockerClient (progress lines).
 *   3. run `rebuild_container <name>` via the injected StreamedProcessRunner,
 *      capturing merged stdout/stderr line-by-line.
 *   4. idempotent `.start()` (304 = already running is success, not
 *      failure) -- fresh CA installs are not in the docker autostart list,
 *      so without this the container stays Exited after rebuild_container.
 *
 * Every call records an audit entry synchronously, BEFORE the async
 * pipeline is kicked off -- the mutation returning `status=RUNNING` and
 * the audit record both happen in the same synchronous tick.
 */
import {
  appendLine,
  createOperation,
  failOperation,
  succeedOperation,
  type OperationSnapshot,
} from '../../operations/registry.js';
import type { AuditCaller, AuditLogger } from '../../audit.js';
import { isDockerApiError, type DockerClient, type DockerPullProgressEvent } from '../../platform/docker-client.js';
import type { StreamedProcessRunner } from '../../platform/process-runner.js';
import {
  buildTemplateXml,
  sanitiseContainerName,
  type DockerTemplateXmlInput,
} from './xml.js';

/** DOCKER_INSTALL: channel prefix, matching the legacy bundle's
 * `CHANNEL_PREFIX` so the wire concept (one channel per docker
 * install/edit/update operation) carries over unchanged. */
export const DOCKER_INSTALL_CHANNEL_PREFIX = 'DOCKER_INSTALL';

export const TEMPLATES_USER_DIR = '/boot/config/plugins/dockerMan/templates-user';
export const REBUILD_CONTAINER_CLI =
  '/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/rebuild_container';

export interface DockerInstallSubject {
  readonly containerName: string;
  readonly repository: string;
}

export type DockerTemplateInstallInput = DockerTemplateXmlInput & { readonly name: string };

/** Injectable template-file writer -- production wiring shells to
 * fs/promises `writeFile` (after `mkdir(TEMPLATES_USER_DIR, {recursive:
 * true})`); tests inject a fake so nothing here touches
 * `/boot/config/...`. */
export type WriteTemplateFile = (name: string, xmlContent: string) => Promise<void>;

export interface InstallDockerTemplateDeps {
  readonly dockerClient: DockerClient;
  readonly runRebuildContainer: StreamedProcessRunner;
  readonly writeTemplateFile: WriteTemplateFile;
  readonly audit: AuditLogger;
  readonly caller: AuditCaller;
}

function templatePath(name: string): string {
  return `${TEMPLATES_USER_DIR}/my-${name}.xml`;
}

/** Renders one dockerode pull-progress event to a human-readable line, or
 * null when the event carries nothing worth showing. Ported verbatim from
 * the Python patches' `formatPullEvent()`. */
function formatPullEvent(event: DockerPullProgressEvent): string | null {
  if (event.error) return `Error: ${event.error}`;
  if (!event.status) return null;
  const layer = event.id ? `IMAGE ID [${event.id}]: ` : '';
  const detail = event.progressDetail;
  if (
    detail &&
    typeof detail.current === 'number' &&
    typeof detail.total === 'number' &&
    detail.total > 0
  ) {
    const percent = Math.floor((detail.current / detail.total) * 100);
    const totalMb = (detail.total / (1024 * 1024)).toFixed(0);
    return `${layer}${event.status} ${percent}% of ${totalMb} MB`;
  }
  return `${layer}${event.status}`;
}

async function pullImage(
  operationId: string,
  repository: string,
  dockerClient: DockerClient,
): Promise<void> {
  if (!repository) return;
  appendLine(operationId, `Pulling image ${repository}`);
  await dockerClient.pull(repository, (event) => {
    const line = formatPullEvent(event);
    if (line) appendLine(operationId, line);
  });
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

async function startContainer(
  operationId: string,
  name: string,
  dockerClient: DockerClient,
): Promise<void> {
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

async function runInstall(
  operationId: string,
  input: DockerTemplateInstallInput,
  name: string,
  deps: InstallDockerTemplateDeps,
): Promise<void> {
  const xml = buildTemplateXml(input, name);
  await deps.writeTemplateFile(name, xml);
  appendLine(operationId, `Wrote template ${templatePath(name)}`);
  await pullImage(operationId, input.repository, deps.dockerClient);
  await rebuildContainer(operationId, name, deps.runRebuildContainer);
  // rebuild_container only auto-starts containers already in Unraid's
  // autostart list; a fresh CA install is not, so without this call the
  // container stays Exited. dockerode's start() is idempotent (304 when
  // already running, handled above as success).
  await startContainer(operationId, name, deps.dockerClient);
  succeedOperation(operationId);
}

/**
 * Starts an async Docker template install. Returns the operation snapshot
 * immediately (status=RUNNING); the pipeline runs in the background and
 * streams progress via the operation registry's delta events. Throws
 * synchronously (before any audit record or side effect) if the container
 * name fails sanitisation.
 */
export function installDockerTemplate(
  input: DockerTemplateInstallInput,
  deps: InstallDockerTemplateDeps,
): OperationSnapshot<DockerInstallSubject> {
  const containerName = sanitiseContainerName(input.name);

  const operation = createOperation<DockerInstallSubject>(DOCKER_INSTALL_CHANNEL_PREFIX, {
    containerName,
    repository: input.repository,
  });

  deps.audit.recordAuditEvent({
    action: 'docker.templateInstall',
    caller: deps.caller,
    target: containerName,
    outcome: 'initiated',
  });

  runInstall(operation.id, input, containerName, deps).catch((error: unknown) => {
    failOperation(operation.id, error);
  });

  return operation;
}
