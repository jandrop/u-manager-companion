/**
 * Thin resolver-binding layer.
 *
 * Binds SDL fields (schema/schema.graphql) to the feature modules under
 * `features/*`. Three responsibilities, kept deliberately thin:
 *
 *   1. Permission gate -- every privileged field calls auth/permissions.ts's
 *      isAuthorized() against the resolved identity, throwing
 *      context.ts's PermissionError on failure (WS per-operation / HTTP
 *      mapping happens at the transport layer in server.ts -- this module
 *      only ever throws the ONE error type, same pattern context.ts itself
 *      follows for AuthenticationError).
 *   2. Feature module delegation -- every resolver calls exactly one
 *      feature-module entry point, injected via GraphqlContext.deps so
 *      server.ts wires the REAL feature modules while tests inject fakes.
 *   3. GraphQL-shape mapping -- operations/registry.ts's
 *      OperationSnapshot<TSubject> is GENERIC (a `subject` field, never
 *      Docker/plugin-shaped). toDockerInstallOperation()/
 *      toPluginInstallOperation() below are this service's equivalent of
 *      the reference bundle's `toGraphqlOperation()` step: they narrow a
 *      snapshot's subject into the SDL's DockerInstallOperation /
 *      PluginInstallOperation shape.
 *
 * Does NOT wire the Apollo server itself -- this module only exports the
 * `resolvers` map object; mounting it onto Apollo Server + graphql-ws is
 * server.ts's job.
 */
import { GraphQLError } from 'graphql';
import type { ResolvedIdentity } from './auth/keystore.js';
import { isAuthorized, type CompanionOperation } from './auth/permissions.js';
import { PermissionError } from './context.js';
import { getSnapshot, type OperationSnapshot } from './operations/registry.js';
import { pubsub, channelFor } from './pubsub.js';
import { getCapabilities } from './health.js';
import type { AuditCaller } from './audit.js';

import type { DockerTemplateInstallInput } from './features/docker_template/install.js';
import type { DockerInstallSubject } from './features/docker_template/install.js';
import type { DockerTemplateEditInput } from './features/docker_template/edit.js';
import type { ParsedDockerTemplate, DockerConfigEntryTypeXml } from './features/docker_template/xml.js';
import type { PluginInstallSubject } from './features/plugins/uninstall.js';

// ---------------------------------------------------------------------------
// Context + injected feature-module surface
// ---------------------------------------------------------------------------

/** Every feature-module entry point resolvers.ts delegates to, injected so
 * server.ts wires real implementations while tests inject fakes.
 * Return/param shapes mirror each feature module's own exported function
 * signature exactly -- resolvers.ts adds no business logic of its own
 * beyond permission gating + shape mapping. */
export interface FeatureModuleDeps {
  readonly installDockerTemplate: (
    input: DockerTemplateInstallInput,
    caller: AuditCaller,
  ) => OperationSnapshot<DockerInstallSubject>;
  readonly editDockerTemplate: (
    input: DockerTemplateEditInput,
    caller: AuditCaller,
  ) => OperationSnapshot<DockerInstallSubject>;
  readonly deleteDockerTemplate: (
    name: string,
    removeContainer: boolean | undefined,
    removeImage: boolean | undefined,
    caller: AuditCaller,
  ) => Promise<boolean>;
  readonly readDockerTemplate: (name: string) => Promise<ParsedDockerTemplate | null>;
  readonly updateContainerStream: (
    idOrName: string,
    caller: AuditCaller,
  ) => OperationSnapshot<DockerInstallSubject>;
  readonly updateAllContainersStream: (
    caller: AuditCaller,
  ) => OperationSnapshot<DockerInstallSubject>;
  readonly checkForDockerUpdates: (caller: AuditCaller) => Promise<boolean>;
  readonly shutdownServer: (caller: AuditCaller) => boolean;
  readonly rebootServer: (caller: AuditCaller) => boolean;
  readonly sleepServer: (caller: AuditCaller) => boolean;
  readonly uninstallPlugin: (
    filename: string,
    caller: AuditCaller,
  ) => OperationSnapshot<PluginInstallSubject>;
  readonly checkForPluginUpdates: () => boolean;
}

export interface GraphqlContext {
  readonly identity: ResolvedIdentity;
  readonly deps: FeatureModuleDeps;
}

// ---------------------------------------------------------------------------
// Permission gate
// ---------------------------------------------------------------------------

function requirePermission(context: GraphqlContext, operation: CompanionOperation): AuditCaller {
  if (!isAuthorized(context.identity, operation)) {
    throw new PermissionError(`Insufficient permissions for ${operation}`);
  }
  return { id: context.identity.id, name: context.identity.name };
}

// ---------------------------------------------------------------------------
// Snapshot -> GraphQL shape mapping (this service's toGraphqlOperation())
// ---------------------------------------------------------------------------

interface GraphqlDockerInstallOperation {
  readonly id: string;
  readonly containerName: string;
  readonly repository: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly finishedAt: string | null;
  readonly output: readonly string[];
}

function toDockerInstallOperation(
  snapshot: OperationSnapshot<DockerInstallSubject>,
): GraphqlDockerInstallOperation {
  return {
    id: snapshot.id,
    containerName: snapshot.subject.containerName,
    repository: snapshot.subject.repository,
    status: snapshot.status,
    createdAt: snapshot.createdAt.toISOString(),
    updatedAt: snapshot.updatedAt.toISOString(),
    finishedAt: snapshot.finishedAt ? snapshot.finishedAt.toISOString() : null,
    output: snapshot.output,
  };
}

interface GraphqlPluginInstallOperation {
  readonly id: string;
  readonly url: string | null;
  readonly name: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly finishedAt: string | null;
  readonly output: readonly string[];
}

function toPluginInstallOperation(
  snapshot: OperationSnapshot<PluginInstallSubject>,
): GraphqlPluginInstallOperation {
  return {
    id: snapshot.id,
    url: snapshot.subject.url,
    name: snapshot.subject.name,
    status: snapshot.status,
    createdAt: snapshot.createdAt.toISOString(),
    updatedAt: snapshot.updatedAt.toISOString(),
    finishedAt: snapshot.finishedAt ? snapshot.finishedAt.toISOString() : null,
    output: snapshot.output,
  };
}

/** DOCKER_INSTALL is the single shared channel prefix used by
 * install/edit/updateContainerStream/updateAllContainersStream -- matches
 * install.ts's DOCKER_INSTALL_CHANNEL_PREFIX constant (duplicated here as
 * a literal to avoid resolvers.ts depending on install.ts purely for a
 * string constant; both must stay in sync with the ported reference's
 * `CHANNEL_PREFIX`). */
const DOCKER_INSTALL_CHANNEL_PREFIX = 'DOCKER_INSTALL';
const PLUGIN_INSTALL_CHANNEL_PREFIX = 'PLUGIN_INSTALL';

// ---------------------------------------------------------------------------
// Input mapping (SDL DockerTemplateInput/DockerTemplateConfigInput -> the
// feature modules' DockerTemplateXmlInput/DockerConfigEntry shapes)
// ---------------------------------------------------------------------------

interface DockerTemplateConfigInputArg {
  readonly name: string;
  readonly type: string;
  readonly target: string;
  readonly value: string;
  readonly default: string;
  readonly mode: string;
  readonly description: string;
  readonly display: string;
  readonly required: boolean;
  readonly mask: boolean;
}

interface DockerTemplateInputArg {
  readonly name: string;
  readonly repository: string;
  readonly network: string;
  readonly privileged: boolean;
  readonly shell: string;
  readonly overview?: string | null;
  readonly icon?: string | null;
  readonly webui?: string | null;
  readonly support?: string | null;
  readonly project?: string | null;
  readonly readme?: string | null;
  readonly registry?: string | null;
  readonly extraParams?: string | null;
  readonly postArgs?: string | null;
  readonly cpuset?: string | null;
  readonly fixedMac?: string | null;
  readonly configs: readonly DockerTemplateConfigInputArg[];
}

/** SDL DockerConfigEntryType wire values (upper-case) -> the XML title-case
 * form xml.ts's buildTemplateXml expects. */
const CONFIG_TYPE_WIRE_TO_XML: Readonly<Record<string, DockerConfigEntryTypeXml>> = {
  PATH: 'Path',
  PORT: 'Port',
  VARIABLE: 'Variable',
  LABEL: 'Label',
  DEVICE: 'Device',
};

function mapTemplateInput(
  input: DockerTemplateInputArg,
): DockerTemplateInstallInput & DockerTemplateEditInput {
  return {
    name: input.name,
    repository: input.repository,
    network: input.network,
    privileged: input.privileged,
    shell: input.shell,
    ...(input.overview != null ? { overview: input.overview } : {}),
    ...(input.icon != null ? { icon: input.icon } : {}),
    ...(input.webui != null ? { webui: input.webui } : {}),
    ...(input.support != null ? { support: input.support } : {}),
    ...(input.project != null ? { project: input.project } : {}),
    ...(input.readme != null ? { readme: input.readme } : {}),
    ...(input.registry != null ? { registry: input.registry } : {}),
    ...(input.extraParams != null ? { extraParams: input.extraParams } : {}),
    ...(input.postArgs != null ? { postArgs: input.postArgs } : {}),
    ...(input.cpuset != null ? { cpuset: input.cpuset } : {}),
    ...(input.fixedMac != null ? { fixedMac: input.fixedMac } : {}),
    configs: input.configs.map((config) => ({
      name: config.name,
      target: config.target,
      type: CONFIG_TYPE_WIRE_TO_XML[config.type] ?? 'Variable',
      value: config.value,
      default: config.default,
      mode: config.mode,
      description: config.description,
      display: config.display,
      required: config.required,
      mask: config.mask,
    })),
  };
}

/**
 * Extracts the bare container id/name from an upstream `PrefixedID`
 * (`docker:<hash>`, or a `<serverId>:<containerId>` pair as the app
 * sends it). dockerode's `getContainer` needs the raw id/name -- passing
 * the whole prefixed value yields a spurious "(HTTP code 404) no such
 * container". Container ids (hex) and names never contain a colon, so the
 * segment after the last colon is always the real identifier; a bare id
 * with no prefix is returned unchanged.
 */
function stripPrefixedId(id: string): string {
  const separator = id.lastIndexOf(':');
  return separator === -1 ? id : id.slice(separator + 1);
}

// ---------------------------------------------------------------------------
// Resolver map
// ---------------------------------------------------------------------------

export const resolvers = {
  Query: {
    dockerInstallOperation(
      _parent: unknown,
      args: { operationId: string },
      _context: GraphqlContext,
    ): GraphqlDockerInstallOperation | null {
      const snapshot = getSnapshot<DockerInstallSubject>(args.operationId);
      return snapshot ? toDockerInstallOperation(snapshot) : null;
    },
    dockerTemplate(
      _parent: unknown,
      args: { name: string },
      context: GraphqlContext,
    ): Promise<ParsedDockerTemplate | null> {
      return context.deps.readDockerTemplate(args.name);
    },
    capabilities(): ReturnType<typeof getCapabilities> {
      return getCapabilities();
    },
  },

  Mutation: {
    docker: (): Record<string, never> => ({}),
    serverPower: (): Record<string, never> => ({}),
    unraidPlugins: (): Record<string, never> => ({}),
  },

  DockerMutations: {
    installDockerTemplate(
      _parent: unknown,
      args: { input: DockerTemplateInputArg },
      context: GraphqlContext,
    ): GraphqlDockerInstallOperation {
      const caller = requirePermission(context, 'docker.templateInstall');
      const snapshot = context.deps.installDockerTemplate(mapTemplateInput(args.input), caller);
      return toDockerInstallOperation(snapshot);
    },
    updateDockerTemplate(
      _parent: unknown,
      args: { input: DockerTemplateInputArg },
      context: GraphqlContext,
    ): GraphqlDockerInstallOperation {
      const caller = requirePermission(context, 'docker.templateEdit');
      const snapshot = context.deps.editDockerTemplate(mapTemplateInput(args.input), caller);
      return toDockerInstallOperation(snapshot);
    },
    deleteDockerTemplate(
      _parent: unknown,
      args: { name: string; removeContainer?: boolean | null; removeImage?: boolean | null },
      context: GraphqlContext,
    ): Promise<boolean> {
      const caller = requirePermission(context, 'docker.templateDelete');
      return context.deps.deleteDockerTemplate(
        args.name,
        args.removeContainer ?? undefined,
        args.removeImage ?? undefined,
        caller,
      );
    },
    updateContainerStream(
      _parent: unknown,
      args: { id: string },
      context: GraphqlContext,
    ): GraphqlDockerInstallOperation {
      const caller = requirePermission(context, 'docker.updateStream');
      const snapshot = context.deps.updateContainerStream(
        stripPrefixedId(args.id),
        caller,
      );
      return toDockerInstallOperation(snapshot);
    },
    updateAllContainersStream(
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphqlContext,
    ): GraphqlDockerInstallOperation {
      const caller = requirePermission(context, 'docker.updateStream');
      const snapshot = context.deps.updateAllContainersStream(caller);
      return toDockerInstallOperation(snapshot);
    },
    checkForUpdates(
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphqlContext,
    ): Promise<boolean> {
      const caller = requirePermission(context, 'docker.checkForUpdates');
      return context.deps.checkForDockerUpdates(caller);
    },
  },

  ServerPowerMutations: {
    shutdown(_parent: unknown, _args: Record<string, never>, context: GraphqlContext): boolean {
      const caller = requirePermission(context, 'power');
      return context.deps.shutdownServer(caller);
    },
    reboot(_parent: unknown, _args: Record<string, never>, context: GraphqlContext): boolean {
      const caller = requirePermission(context, 'power');
      return context.deps.rebootServer(caller);
    },
    sleep(_parent: unknown, _args: Record<string, never>, context: GraphqlContext): boolean {
      const caller = requirePermission(context, 'power');
      return context.deps.sleepServer(caller);
    },
  },

  UnraidPluginsMutations: {
    uninstallPlugin(
      _parent: unknown,
      args: { filename: string },
      context: GraphqlContext,
    ): GraphqlPluginInstallOperation {
      const caller = requirePermission(context, 'plugins.uninstall');
      const snapshot = context.deps.uninstallPlugin(args.filename, caller);
      return toPluginInstallOperation(snapshot);
    },
    // Permission-gated for consistency with docker.checkForUpdates (which is
    // gated) and with OPERATION_PERMISSIONS, which lists plugins.checkForUpdates
    // as PLUGINS:update. Live testing showed a VIEWER (read-only) key could
    // trigger `plugin checkall` here -- a network-touching side effect a
    // read-only caller should not be able to initiate. Fail-closed: only
    // callers authorised for the plugins update action may run it. It remains
    // un-AUDITED (no state change to reconstruct), which is a separate concern
    // from authorisation.
    checkForUpdates(_parent: unknown, _args: Record<string, never>, context: GraphqlContext): boolean {
      requirePermission(context, 'plugins.checkForUpdates');
      return context.deps.checkForPluginUpdates();
    },
  },

  Subscription: {
    dockerInstallUpdates: {
      subscribe(
        _parent: unknown,
        args: { operationId: string },
        _context: GraphqlContext,
      ): AsyncIterator<unknown> {
        if (!getSnapshot(args.operationId)) {
          throw new GraphQLError(`Unknown Docker install operation: ${args.operationId}`);
        }
        return pubsub.asyncIterator(channelFor(DOCKER_INSTALL_CHANNEL_PREFIX, args.operationId));
      },
    },
  },
};

/** Exported for server.ts -- the plugin-install channel prefix used by a
 * future pluginInstallUpdates subscription, kept alongside resolvers.ts
 * since it is resolver-map-adjacent wiring, not feature business logic.
 * Not yet wired to an SDL Subscription field -- v1's schema.graphql only
 * exposes dockerInstallUpdates (plugin uninstall progress is observable
 * via the returned PluginInstallOperation's output snapshot + polling
 * dockerInstallOperation-equivalent, matching v1 scope). */
export { PLUGIN_INSTALL_CHANNEL_PREFIX };
