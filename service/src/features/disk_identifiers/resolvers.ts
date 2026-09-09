/**
 * Disk-identifiers feature module.
 *
 * Backs the SDL's `diskIdentifiers` query, which carries the addressing for
 * both per-disk mutations: the device id the SMART ones take as `diskId`,
 * and the array slot index updateDiskUtilizationThresholds takes.
 *
 * Read-only, ungated and unaudited, the same posture as
 * `diskThresholds`/`diskSmartSettings` -- the webGUI shows these
 * identifiers on its own pages.
 */
import type { DiskIdentifierRecord, DiskStateClient } from './platform.js';
import { parseAssignedDiskIdentifiers, parseUnassignedDiskIdentifiers } from './platform.js';

interface ClientDeps {
  readonly client: DiskStateClient;
}

/** Assigned disks first, then unassigned devices, each in file order. A
 * missing file contributes no entries rather than failing the query. */
export async function listDiskIdentifiers(
  deps: ClientDeps,
): Promise<readonly DiskIdentifierRecord[]> {
  const [assignedText, unassignedText] = await Promise.all([
    deps.client.readAssignedText(),
    deps.client.readUnassignedText(),
  ]);

  return [
    ...parseAssignedDiskIdentifiers(assignedText),
    ...parseUnassignedDiskIdentifiers(unassignedText),
  ];
}
