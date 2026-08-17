/**
 * Pure raw-chunk-to-sample mapping. No state, no I/O, no clock except the
 * `read`-parse fallback.
 */
import type { DockerStatsChunk } from '../../platform/docker-client.js';

export interface DockerContainerStatsSample {
  readonly id: string;
  readonly cpuPercent: number;
  readonly memUsedBytes: number;
  readonly memTotalBytes: number;
  readonly netRxBytes: number | null;
  readonly netTxBytes: number | null;
  readonly blkReadBytes: number | null;
  readonly blkWriteBytes: number | null;
  readonly sampledAtMs: number;
}

/** Same basis as `docker stats`: summed across online CPUs. A negative
 * system delta (clock skew/restart) or negative usage delta is not a real
 * rate -- report 0 rather than a nonsense negative or infinite percentage. */
function computeCpuPercent(chunk: DockerStatsChunk): number {
  const cpuDelta = (chunk.cpu_stats?.cpu_usage?.total_usage ?? 0) - (chunk.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (chunk.cpu_stats?.system_cpu_usage ?? 0) - (chunk.precpu_stats?.system_cpu_usage ?? 0);
  if (systemDelta <= 0 || cpuDelta < 0) return 0;
  const onlineCpus = chunk.cpu_stats?.online_cpus ?? 1;
  return (cpuDelta / systemDelta) * onlineCpus * 100;
}

/** `inactive_file` is the cgroup-v2 key; `cache` only exists on cgroup v1
 * and must stay a fallback -- see the memory-formula discovery: subtracting
 * `cache` first reports ~38% high on a v2 host where that key is absent. */
function computeMemUsedBytes(chunk: DockerStatsChunk): number {
  const usage = chunk.memory_stats?.usage ?? 0;
  const stats = chunk.memory_stats?.stats;
  const excluded = stats?.inactive_file ?? stats?.total_inactive_file ?? stats?.cache ?? 0;
  return usage - excluded;
}

/** `null` (never `0`) when `networks` is absent/empty -- that is how a
 * NetworkMode=host container is told apart from an idle one. */
function sumNetwork(chunk: DockerStatsChunk, key: 'rx_bytes' | 'tx_bytes'): number | null {
  const interfaces = Object.values(chunk.networks ?? {});
  if (interfaces.length === 0) return null;
  return interfaces.reduce((total, iface) => total + (iface[key] ?? 0), 0);
}

/** Same null-vs-empty distinction as sumNetwork, for blkio counters. */
function sumBlkio(chunk: DockerStatsChunk, ops: readonly string[]): number | null {
  const entries = chunk.blkio_stats?.io_service_bytes_recursive;
  if (!entries || entries.length === 0) return null;
  return entries.reduce((total, entry) => (entry.op && ops.includes(entry.op) ? total + (entry.value ?? 0) : total), 0);
}

/** Docker's own sample clock, never a clock downstream of it -- so neither
 * event-loop jitter here nor a slow client distorts a client-computed rate.
 * Falls back to the service clock when `read` is absent, unparseable, or
 * Docker's `0001-01-01T00:00:00Z` zero-time (parses to a large negative). */
function parseSampledAtMs(read: string | undefined): number {
  const parsed = read ? Date.parse(read) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}

export function toSample(id: string, chunk: DockerStatsChunk): DockerContainerStatsSample {
  return {
    id,
    cpuPercent: computeCpuPercent(chunk),
    memUsedBytes: computeMemUsedBytes(chunk),
    memTotalBytes: chunk.memory_stats?.limit ?? 0,
    netRxBytes: sumNetwork(chunk, 'rx_bytes'),
    netTxBytes: sumNetwork(chunk, 'tx_bytes'),
    blkReadBytes: sumBlkio(chunk, ['Read', 'read']),
    blkWriteBytes: sumBlkio(chunk, ['Write', 'write']),
    sampledAtMs: parseSampledAtMs(chunk.read),
  };
}
