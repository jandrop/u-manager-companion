/**
 * map.ts tests -- pure raw-chunk-to-sample arithmetic.
 *
 * TDD: written before map.ts exists -> RED first.
 */
import { describe, expect, it } from 'vitest';
import type { DockerStatsChunk } from '../../../platform/docker-client.js';
import { toSample } from '../map.js';

describe('toSample -- CPU / memory / network happy path', () => {
  it('computes cpuPercent across online_cpus, cgroup-v2 memory, and network summed over two interfaces', () => {
    const chunk: DockerStatsChunk = {
      read: '2026-08-16T17:19:43.661107911Z',
      cpu_stats: {
        cpu_usage: { total_usage: 2_000_000_000 },
        system_cpu_usage: 20_000_000_000,
        online_cpus: 4,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 1_000_000_000 },
        system_cpu_usage: 15_000_000_000,
      },
      memory_stats: {
        usage: 100_000_000,
        limit: 500_000_000,
        stats: { inactive_file: 15_572_992 },
      },
      networks: {
        eth0: { rx_bytes: 1000, tx_bytes: 2000 },
        eth1: { rx_bytes: 500, tx_bytes: 250 },
      },
    };

    const sample = toSample('abc123', chunk);

    // cd = 1e9, sd = 5e9, oc = 4 -> (1e9/5e9)*4*100 = 80
    expect(sample.cpuPercent).toBe(80);
    expect(sample.memUsedBytes).toBe(100_000_000 - 15_572_992);
    expect(sample.memTotalBytes).toBe(500_000_000);
    expect(sample.netRxBytes).toBe(1500);
    expect(sample.netTxBytes).toBe(2250);
    expect(sample.sampledAtMs).toBe(Date.parse('2026-08-16T17:19:43.661107911Z'));
  });
});

describe('toSample -- CPU delta guard', () => {
  it('yields cpuPercent 0 when the system delta is <= 0', () => {
    const chunk: DockerStatsChunk = {
      cpu_stats: { cpu_usage: { total_usage: 2_000 }, system_cpu_usage: 10_000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 10_000 },
    };
    expect(toSample('id', chunk).cpuPercent).toBe(0);
  });

  it('yields cpuPercent 0 when the cpu-usage delta is negative', () => {
    const chunk: DockerStatsChunk = {
      cpu_stats: { cpu_usage: { total_usage: 500 }, system_cpu_usage: 20_000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 10_000 },
    };
    expect(toSample('id', chunk).cpuPercent).toBe(0);
  });
});

describe('toSample -- cgroup-v1 memory fallback', () => {
  it('subtracts stats.cache when inactive_file is absent (cgroup v1)', () => {
    const chunk: DockerStatsChunk = {
      memory_stats: { usage: 53_600_000, limit: 500_000_000, stats: { cache: 14_800_000 } },
    };
    expect(toSample('id', chunk).memUsedBytes).toBe(53_600_000 - 14_800_000);
  });
});

describe('toSample -- host-network case', () => {
  it('yields null network fields when networks is absent', () => {
    const sample = toSample('id', {});
    expect(sample.netRxBytes).toBeNull();
    expect(sample.netTxBytes).toBeNull();
  });

  it('yields null network fields when networks is an empty object', () => {
    const sample = toSample('id', { networks: {} });
    expect(sample.netRxBytes).toBeNull();
    expect(sample.netTxBytes).toBeNull();
  });
});

describe('toSample -- missing blkio', () => {
  it('yields null blkio fields when blkio_stats is absent', () => {
    const sample = toSample('id', {});
    expect(sample.blkReadBytes).toBeNull();
    expect(sample.blkWriteBytes).toBeNull();
  });

  it('yields null blkio fields when io_service_bytes_recursive is empty', () => {
    const sample = toSample('id', { blkio_stats: { io_service_bytes_recursive: [] } });
    expect(sample.blkReadBytes).toBeNull();
    expect(sample.blkWriteBytes).toBeNull();
  });

  it('sums Read/Write entries when present', () => {
    const sample = toSample('id', {
      blkio_stats: {
        io_service_bytes_recursive: [
          { op: 'Read', value: 100 },
          { op: 'Write', value: 200 },
          { op: 'Read', value: 50 },
        ],
      },
    });
    expect(sample.blkReadBytes).toBe(150);
    expect(sample.blkWriteBytes).toBe(200);
  });
});

describe('toSample -- sampledAtMs fallback', () => {
  it('falls back to the service clock when read is absent', () => {
    const before = Date.now();
    const sample = toSample('id', {});
    const after = Date.now();
    expect(sample.sampledAtMs).toBeGreaterThanOrEqual(before);
    expect(sample.sampledAtMs).toBeLessThanOrEqual(after);
  });

  it('falls back to the service clock on Docker zero-time', () => {
    const before = Date.now();
    const sample = toSample('id', { read: '0001-01-01T00:00:00Z' });
    const after = Date.now();
    expect(sample.sampledAtMs).toBeGreaterThanOrEqual(before);
    expect(sample.sampledAtMs).toBeLessThanOrEqual(after);
  });
});
