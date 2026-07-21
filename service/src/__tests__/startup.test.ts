/**
 * Startup sequence tests: composing crash-recovery -> ensure-include +
 * validated reload -> self-heal monitor start.
 *
 * TDD: written before startup.ts exists -> RED first. All fs/nginx paths are
 * injected/temp-dir based -- nothing here touches the real filesystem or a
 * real `nginx` binary.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { runNginxStartupSequence } from '../startup.js';
import { resolveCompanionConfig } from '../platform/config.js';
import type { NginxRunResult, RunNginx } from '../nginx/validated-reload.js';

let dir: string;
let locationsConfPath: string;
let includePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'companion-startup-'));
  locationsConfPath = path.join(dir, 'locations.conf');
  includePath = path.join(dir, 'plugin', 'companion-graphql.conf');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function passingRunNginx(): RunNginx & Mock {
  return vi.fn(async (): Promise<NginxRunResult> => ({ exitCode: 0, stdout: '', stderr: '' }));
}

function noopWatchFile() {
  return vi.fn(() => ({ close: vi.fn() }));
}

describe('runNginxStartupSequence', () => {
  it('when nginx is disabled, performs no fs/process work and returns a no-op monitor handle', async () => {
    const config = resolveCompanionConfig({
      COMPANION_NGINX_ENABLED: 'false',
      COMPANION_LOCATIONS_CONF_PATH: locationsConfPath,
      COMPANION_INCLUDE_PATH: includePath,
    });

    const monitor = await runNginxStartupSequence(config);

    expect(existsSync(locationsConfPath)).toBe(false);
    expect(existsSync(includePath)).toBe(false);
    expect(() => monitor.close()).not.toThrow();
  });

  it('when nginx is enabled: writes the include file, appends the include line, and validated-reloads', async () => {
    writeFileSync(locationsConfPath, '# platform-generated\n');
    const runNginx = passingRunNginx();

    const config = resolveCompanionConfig({
      COMPANION_NGINX_ENABLED: 'true',
      COMPANION_LOCATIONS_CONF_PATH: locationsConfPath,
      COMPANION_INCLUDE_PATH: includePath,
      COMPANION_SERVICE_PORT: '34400',
    });

    const monitor = await runNginxStartupSequence(config, {
      runNginx,
      watchFile: noopWatchFile(),
    });

    expect(existsSync(includePath)).toBe(true);
    expect(readFileSync(includePath, 'utf8')).toContain('proxy_pass http://127.0.0.1:34400;');
    expect(readFileSync(locationsConfPath, 'utf8')).toContain(`include ${includePath};`);
    expect(runNginx).toHaveBeenCalledWith(config.nginxBinaryPath, ['-t']);
    expect(runNginx).toHaveBeenCalledWith(config.nginxBinaryPath, ['-s', 'reload']);

    monitor.close();
  });

  it('skips the reload when the include line was already present (idempotent startup)', async () => {
    const runNginx = passingRunNginx();
    const config = resolveCompanionConfig({
      COMPANION_NGINX_ENABLED: 'true',
      COMPANION_LOCATIONS_CONF_PATH: locationsConfPath,
      COMPANION_INCLUDE_PATH: includePath,
      COMPANION_SERVICE_PORT: '34400',
    });

    // First run establishes the include line + file.
    await runNginxStartupSequence(config, { runNginx, watchFile: noopWatchFile() });
    runNginx.mockClear();

    // Second run against the SAME locations.conf (line already present)
    // must not trigger a reload -- avoids reload storms on restart.
    const monitor = await runNginxStartupSequence(config, { runNginx, watchFile: noopWatchFile() });

    expect(runNginx).not.toHaveBeenCalled();
    monitor.close();
  });

  it('reloads when the include CONTENT changed even though the include line is already present', async () => {
    const runNginx = passingRunNginx();
    const firstConfig = resolveCompanionConfig({
      COMPANION_NGINX_ENABLED: 'true',
      COMPANION_LOCATIONS_CONF_PATH: locationsConfPath,
      COMPANION_INCLUDE_PATH: includePath,
      COMPANION_SERVICE_PORT: '34400',
    });
    // First run: establishes the include file + line at port 34400.
    await runNginxStartupSequence(firstConfig, { runNginx, watchFile: noopWatchFile() });
    runNginx.mockClear();

    // Second run: line is already present, but the generated content differs
    // (different upstream port). nginx caches config in memory, so this MUST
    // trigger a reload or the stale include keeps serving.
    const secondConfig = resolveCompanionConfig({
      COMPANION_NGINX_ENABLED: 'true',
      COMPANION_LOCATIONS_CONF_PATH: locationsConfPath,
      COMPANION_INCLUDE_PATH: includePath,
      COMPANION_SERVICE_PORT: '34500',
    });
    const monitor = await runNginxStartupSequence(secondConfig, {
      runNginx,
      watchFile: noopWatchFile(),
    });

    expect(readFileSync(includePath, 'utf8')).toContain('proxy_pass http://127.0.0.1:34500;');
    expect(runNginx).toHaveBeenCalledWith(secondConfig.nginxBinaryPath, ['-s', 'reload']);
    monitor.close();
  });

  it('runs crash-recovery before ensure-include: restores a leftover .bak marker first', async () => {
    writeFileSync(locationsConfPath, `include ${includePath};\n`);
    const goodContent = '# known-good backup content\n';
    // Simulate a crash mid-validated-reload: a `.bak` marker is present.
    mkdirSync(path.dirname(includePath), { recursive: true });
    writeFileSync(`${includePath}.bak`, goodContent);
    writeFileSync(includePath, 'untested-candidate-content');

    const runNginx = passingRunNginx();
    const config = resolveCompanionConfig({
      COMPANION_NGINX_ENABLED: 'true',
      COMPANION_LOCATIONS_CONF_PATH: locationsConfPath,
      COMPANION_INCLUDE_PATH: includePath,
      COMPANION_SERVICE_PORT: '34400',
    });

    await runNginxStartupSequence(config, { runNginx, watchFile: noopWatchFile() });

    // The .bak marker must be gone (crash-recovery ran), and the include
    // line was already present in locations.conf, so ensure-include is a
    // no-op AFTER crash-recovery runs -- but the recovered content gets
    // overwritten by the normal ensure-include-file-content step anyway
    // (both write the same generated content deterministically).
    expect(existsSync(`${includePath}.bak`)).toBe(false);
  });

  it('wires the self-heal monitor heal callback to re-run ensure-include + validated reload', async () => {
    writeFileSync(locationsConfPath, '# platform-generated\n');
    const runNginx = passingRunNginx();

    let capturedOnChange: (() => void) | undefined;
    const watchFile = vi.fn((_path: string, onChange: () => void) => {
      capturedOnChange = onChange;
      return { close: vi.fn() };
    });

    const config = resolveCompanionConfig({
      COMPANION_NGINX_ENABLED: 'true',
      COMPANION_LOCATIONS_CONF_PATH: locationsConfPath,
      COMPANION_INCLUDE_PATH: includePath,
      COMPANION_SERVICE_PORT: '34400',
    });

    const monitor = await runNginxStartupSequence(config, { runNginx, watchFile });
    runNginx.mockClear();

    // Simulate rc.nginx regenerating locations.conf, wiping our line.
    writeFileSync(locationsConfPath, '# regenerated, our line is gone\n');
    expect(capturedOnChange).toBeDefined();
    capturedOnChange?.();

    // The monitor debounces (default 500ms) -- wait past that window.
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(readFileSync(locationsConfPath, 'utf8')).toContain(`include ${includePath};`);
    expect(runNginx).toHaveBeenCalledWith(config.nginxBinaryPath, ['-s', 'reload']);

    monitor.close();
  });
});
