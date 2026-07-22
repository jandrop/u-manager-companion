/**
 * unraidPlugins.uninstallPlugin(filename).
 *
 * Validates the filename (non-empty, no path separators or NUL bytes,
 * must end in `.plg`), then streams `plugin remove <filename>` through
 * this service's operations/registry.ts (generic OperationSnapshot).
 * Audited on start, since uninstall is a privileged action. Uses the
 * SAME PluginInstallOperation shape/channel model as
 * DockerInstallOperation (schema.graphql), since plugin ops track
 * through the same operation pipeline the install flow uses.
 */
import {
  appendLine,
  createOperation,
  failOperation,
  succeedOperation,
  type OperationSnapshot,
} from '../../operations/registry.js';
import type { AuditCaller, AuditLogger } from '../../audit.js';
import type { StreamedProcessRunner } from '../../platform/process-runner.js';

export const PLUGIN_INSTALL_CHANNEL_PREFIX = 'PLUGIN_INSTALL';
export const PLUGIN_CLI = '/usr/local/sbin/plugin';

export interface PluginInstallSubject {
  readonly name: string;
  readonly url: string;
}

export interface UninstallPluginDeps {
  readonly runPluginCli: StreamedProcessRunner;
  readonly audit: AuditLogger;
  readonly caller: AuditCaller;
}

/**
 * Validates a presented `.plg` filename: non-empty after trim, no `/`,
 * `\`, or NUL byte (path-traversal guard -- the filename is used as a
 * bare CLI argument, never joined into a path by this module, but the
 * check stays in for defense in depth), and must end with `.plg`
 * (case-insensitive).
 */
function validateFilename(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Plugin filename cannot be empty.');
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new Error(`Invalid plugin filename: "${raw}".`);
  }
  if (!trimmed.toLowerCase().endsWith('.plg')) {
    throw new Error(`Plugin filename must end with .plg: "${raw}".`);
  }
  return trimmed;
}

async function runRemove(
  operationId: string,
  filename: string,
  runPluginCli: StreamedProcessRunner,
): Promise<void> {
  const result = await runPluginCli(PLUGIN_CLI, ['remove', filename], (line) =>
    appendLine(operationId, line),
  );
  if (result.exitCode !== 0) {
    throw new Error(`plugin remove command exited with ${result.exitCode}`);
  }
  succeedOperation(operationId);
}

/**
 * Starts an async plugin uninstall. Returns the operation snapshot
 * immediately (status=RUNNING); throws synchronously (before any audit
 * record or side effect) if the filename fails validation.
 */
export function uninstallPlugin(
  filename: string,
  deps: UninstallPluginDeps,
): OperationSnapshot<PluginInstallSubject> {
  const trimmed = validateFilename(filename);
  const name = trimmed.replace(/\.plg$/i, '');

  const operation = createOperation<PluginInstallSubject>(PLUGIN_INSTALL_CHANNEL_PREFIX, {
    name,
    url: trimmed,
  });

  deps.audit.recordAuditEvent({
    action: 'plugins.uninstall',
    caller: deps.caller,
    target: trimmed,
    outcome: 'initiated',
  });

  runRemove(operation.id, trimmed, deps.runPluginCli).catch((error: unknown) => {
    failOperation(operation.id, error);
  });

  return operation;
}
