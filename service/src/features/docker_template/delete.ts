/**
 * deleteDockerTemplate.
 *
 * Ported from `docker_template_delete.py`'s `uninstallLikeWebUi()`/
 * `deleteTemplate()`: stop the container if running, remove it (no force,
 * no anonymous-volume wipe), optionally remove its image (swallowing a 409
 * ImageInUse the same way the Unraid PHP handler does) and prune orphaned
 * anonymous volumes. The user-template XML under templates-user is
 * DELIBERATELY LEFT IN PLACE so the entry resurfaces as a "Previous App"
 * in the CA UI for one-click reinstall -- this module never touches the
 * template file.
 *
 * Unlike install/edit, this mutation is SYNCHRONOUS in the SDL
 * (`deleteDockerTemplate(...): Boolean!`, schema.graphql) -- no operation
 * registry involvement, no streamed progress. Audited on completion
 * (succeeded/failed), since there is no "initiated" phase distinct from
 * the synchronous call itself.
 */
import type { AuditCaller, AuditLogger } from '../../audit.js';
import { isDockerApiError, type DockerClient } from '../../platform/docker-client.js';
import { sanitiseContainerName } from './xml.js';

export interface DeleteDockerTemplateDeps {
  readonly dockerClient: DockerClient;
  readonly audit: AuditLogger;
  readonly caller: AuditCaller;
}

async function uninstallLikeWebUi(
  name: string,
  removeImage: boolean,
  dockerClient: DockerClient,
): Promise<void> {
  const container = dockerClient.getContainer(name);
  let imageId: string | undefined;

  // Step 1+2: stop if running, then remove the container.
  try {
    const inspected = await container.inspect();
    imageId = inspected.Image;
    if (inspected.State.Running) {
      try {
        await container.stop();
      } catch {
        // best-effort -- continue to remove even if stop failed.
      }
    }
    await container.remove({ force: false, v: false });
  } catch (error) {
    if (isDockerApiError(error) && error.statusCode === 404) return; // nothing to remove.
    throw error;
  }

  // Stop here when the caller opted out of image removal: the image stays
  // on disk and the volume prune is skipped too.
  if (!removeImage) return;

  // Step 3: remove the image. Mirrors the PHP handler's swallow of the 409
  // ImageInUse error (image still referenced by another container).
  if (imageId) {
    try {
      await dockerClient.getImage(imageId).remove({ force: false });
    } catch {
      /* swallow 409 (and any other removal failure) -- best-effort */
    }
  }

  // Step 4: docker volume prune (best-effort).
  try {
    await dockerClient.pruneVolumes();
  } catch {
    /* best-effort */
  }
}

/**
 * Uninstalls a Docker container the same way the Unraid web UI's "Remove
 * container" dialog does. `removeContainer === false` is a no-op branch
 * reserved for future XML-only flows (mirrors the Python patch's dead
 * branch, kept for SDL-argument compatibility). Throws synchronously (via
 * sanitiseContainerName) on an invalid name, before any audit record.
 */
export async function deleteDockerTemplate(
  name: string,
  removeContainer: boolean | undefined,
  removeImage: boolean | undefined,
  deps: DeleteDockerTemplateDeps,
): Promise<boolean> {
  const safeName = sanitiseContainerName(name);

  if (removeContainer === false) {
    return false;
  }

  try {
    await uninstallLikeWebUi(safeName, removeImage !== false, deps.dockerClient);
    deps.audit.recordAuditEvent({
      action: 'docker.templateDelete',
      caller: deps.caller,
      target: safeName,
      outcome: 'succeeded',
    });
    return true;
  } catch (error) {
    deps.audit.recordAuditEvent({
      action: 'docker.templateDelete',
      caller: deps.caller,
      target: safeName,
      outcome: 'failed',
    });
    throw error;
  }
}
