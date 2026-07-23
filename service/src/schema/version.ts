/**
 * Schema version + capability keys.
 *
 * SCHEMA_VERSION bumps ONLY on breaking SDL changes (removed/renamed
 * fields, changed argument types, tightened nullability). Additive
 * fields do NOT bump it, so older app builds keep working against a
 * newer service. See the app-side CompanionStatusCubit fallback, which
 * trusts this string as-is.
 */
export const SCHEMA_VERSION = '1.0.0';

/**
 * Every v1 capability key the service can serve, keyed to match the
 * app-side feature-gating checks (e.g.
 * `features.contains('docker.templateInstall')`).
 *
 * Naming mirrors the SDL namespace + operation the capability unlocks,
 * NOT the internal feature module layout (`src/features/*`) 1:1 --
 * `docker.templateInstall/templateEdit/templateDelete` all live under
 * one `features/docker_template/` module but are surfaced as separate
 * keys because the app may want to gate them independently in a future
 * release even though v1 always ships all three together.
 */
export const CAPABILITY_KEYS = [
  'docker.templateInstall',
  'docker.templateEdit',
  'docker.templateDelete',
  'docker.updateStream',
  'docker.checkForUpdates',
  'power',
  'plugins.uninstall',
  'plugins.checkForUpdates',
  'plugins.installedDetailed',
  'shares',
] as const;

/** Union of every valid capability key string. */
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
