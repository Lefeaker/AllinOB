import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_OVERLAY_PERMISSIONS,
  applyBuildOverlayManifestPatch,
  createBuildEntrypointPlan,
  loadBuildOverlayManifest
} from '../../../scripts/utils/buildOverlayManifest.mjs';
import { createBrowserManifest } from '../../../scripts/utils/manifestSources.mjs';

function writeFile(path: string, content = 'export {};'): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function createOverlayFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'aiiinob-build-overlay-'));
  const overlayRoot = join(dir, 'overlay-root');
  const background = writeFile(join(overlayRoot, 'entrypoints/background.ts'));
  const content = writeFile(join(overlayRoot, 'entrypoints/content.ts'));
  const options = writeFile(join(overlayRoot, 'entrypoints/options.ts'));
  const assets = join(overlayRoot, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'owner-icon.png'), '');
  const chromePatch = writeFile(
    join(overlayRoot, 'manifest/chrome.patch.json'),
    JSON.stringify({
      web_accessible_resources: [
        {
          resources: ['overlay-assets/*'],
          matches: ['https://example.invalid/*']
        }
      ]
    })
  );
  const firefoxPatch = writeFile(join(overlayRoot, 'manifest/firefox.patch.json'), '{}');
  const manifest = join(dir, 'overlay-manifest.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      allowedRoots: [overlayRoot],
      entryPoints: {
        'background/index': background,
        'content/runtime': content,
        'options/index': options
      },
      staticCopies: [{ from: assets, to: 'overlay-assets' }],
      manifestPatch: {
        chrome: chromePatch,
        firefox: firefoxPatch
      }
    })
  );

  return { assets, background, content, dir, manifest, options, overlayRoot };
}

describe('build overlay manifest', () => {
  it('keeps public entrypoints by default and allows validated overlay replacements', () => {
    const fixture = createOverlayFixture();

    try {
      const publicPlan = createBuildEntrypointPlan();

      expect(publicPlan.backgroundEntryPoints).toEqual({
        'background/index': 'src/background/index.ts'
      });
      expect(publicPlan.appEntryPoints['content/runtime']).toBe('src/content/index.ts');
      expect(publicPlan.appEntryPoints['options/index']).toBe('src/options/index.ts');

      const overlay = loadBuildOverlayManifest(fixture.manifest);
      const overlayPlan = createBuildEntrypointPlan({ overlay });

      expect(overlayPlan.backgroundEntryPoints).toEqual({
        'background/index': realpathSync(fixture.background)
      });
      expect(overlayPlan.appEntryPoints['content/runtime']).toBe(realpathSync(fixture.content));
      expect(overlayPlan.appEntryPoints['options/index']).toBe(realpathSync(fixture.options));
      expect(overlayPlan.appEntryPoints['onboarding/index']).toBe('src/onboarding/index.ts');
      const overlayText = JSON.stringify(overlay);
      expect(overlayText).toContain(realpathSync(fixture.assets));
      expect(overlayText).toContain('overlay-assets/owner-icon.png');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects overlay paths outside declared roots and the public repo root', () => {
    const fixture = createOverlayFixture();
    const outside = writeFile(join(fixture.dir, 'outside-entry.ts'));
    writeFileSync(
      fixture.manifest,
      JSON.stringify({
        schemaVersion: 1,
        allowedRoots: [fixture.overlayRoot],
        entryPoints: {
          'content/runtime': outside
        }
      })
    );

    try {
      expect(() => loadBuildOverlayManifest(fixture.manifest)).toThrow(/outside allowed roots/i);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects symlinked overlay entrypoints that resolve outside declared roots', () => {
    const fixture = createOverlayFixture();
    const outside = writeFile(join(fixture.dir, 'outside-entry.ts'));
    const symlink = join(fixture.overlayRoot, 'entrypoints/symlink-content.ts');
    symlinkSync(outside, symlink);
    writeFileSync(
      fixture.manifest,
      JSON.stringify({
        schemaVersion: 1,
        allowedRoots: [fixture.overlayRoot],
        entryPoints: {
          'content/runtime': symlink
        }
      })
    );

    try {
      expect(() => loadBuildOverlayManifest(fixture.manifest)).toThrow(/outside allowed roots/i);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects secret-like paths nested inside overlay static copy directories', () => {
    const fixture = createOverlayFixture();
    writeFile(join(fixture.overlayRoot, 'assets/nested/.env.production.local'), 'TOKEN=secret');
    writeFileSync(
      fixture.manifest,
      JSON.stringify({
        schemaVersion: 1,
        allowedRoots: [fixture.overlayRoot],
        staticCopies: [{ from: join(fixture.overlayRoot, 'assets'), to: 'overlay-assets' }]
      })
    );

    try {
      expect(() => loadBuildOverlayManifest(fixture.manifest)).toThrow(/forbidden/i);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects token and credential files nested inside overlay static copy directories', () => {
    const fixture = createOverlayFixture();
    writeFile(join(fixture.overlayRoot, 'assets/nested/api-token.json'), '{"token":"secret"}');
    writeFile(join(fixture.overlayRoot, 'assets/nested/credential-note.txt'), 'secret');
    writeFileSync(
      fixture.manifest,
      JSON.stringify({
        schemaVersion: 1,
        allowedRoots: [fixture.overlayRoot],
        staticCopies: [{ from: join(fixture.overlayRoot, 'assets'), to: 'overlay-assets' }]
      })
    );

    try {
      expect(() => loadBuildOverlayManifest(fixture.manifest)).toThrow(/secret-like path/i);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects static copy directories that would overwrite critical public files', () => {
    const fixture = createOverlayFixture();
    writeFile(join(fixture.overlayRoot, 'assets/index.html'), '<!doctype html>');
    writeFileSync(
      fixture.manifest,
      JSON.stringify({
        schemaVersion: 1,
        allowedRoots: [fixture.overlayRoot],
        staticCopies: [{ from: join(fixture.overlayRoot, 'assets'), to: 'options' }]
      })
    );

    try {
      expect(() => loadBuildOverlayManifest(fixture.manifest)).toThrow(/options\/index\.html/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects non-normalized static copy targets before critical overwrite checks', () => {
    const fixture = createOverlayFixture();
    const manifestFile = writeFile(join(fixture.overlayRoot, 'assets/manifest.json'), '{}');
    writeFileSync(
      fixture.manifest,
      JSON.stringify({
        schemaVersion: 1,
        allowedRoots: [fixture.overlayRoot],
        staticCopies: [
          {
            from: manifestFile,
            to: 'options/../manifest.json',
            allowOverwrite: ['options/../manifest.json']
          }
        ]
      })
    );

    try {
      expect(() => loadBuildOverlayManifest(fixture.manifest)).toThrow(/normalized dist path/i);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects forbidden permissions from overlay manifest patches', () => {
    const fixture = createOverlayFixture();
    const patch = writeFile(
      join(fixture.overlayRoot, 'manifest/chrome.patch.json'),
      JSON.stringify({
        permissions: ['storage', 'tabCapture']
      })
    );
    writeFileSync(
      fixture.manifest,
      JSON.stringify({
        schemaVersion: 1,
        allowedRoots: [fixture.overlayRoot],
        manifestPatch: {
          chrome: patch
        }
      })
    );

    try {
      expect(() => loadBuildOverlayManifest(fixture.manifest)).toThrow(/tabCapture/);
      expect(FORBIDDEN_OVERLAY_PERMISSIONS).toEqual([
        'unlimitedStorage',
        'message_serialization',
        'tabCapture'
      ]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('applies a validated manifest patch without mutating public defaults', () => {
    const fixture = createOverlayFixture();

    try {
      const publicManifest = createBrowserManifest('chrome');
      const publicManifestText = JSON.stringify(publicManifest);
      const overlay = loadBuildOverlayManifest(fixture.manifest);
      const patchedText = JSON.stringify(
        applyBuildOverlayManifestPatch(publicManifest, 'chrome', overlay)
      );

      expect(JSON.stringify(createBrowserManifest('chrome'))).toBe(publicManifestText);
      expect(patchedText).toContain('overlay-assets/*');
      expect(patchedText).not.toContain('unlimitedStorage');
      expect(patchedText).not.toContain('message_serialization');
      expect(patchedText).not.toContain('tabCapture');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
