import { describe, expect, it } from 'vitest';
import { createBrowserManifest } from '../../../scripts/utils/manifestSources.mjs';
import { readPackageVersion } from '../../../scripts/utils/packageMetadata.mjs';

describe('manifestSources', () => {
  it('builds a chrome manifest with shared defaults and chrome-only fields', () => {
    const manifest = createBrowserManifest('chrome');

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe(readPackageVersion());
    expect(manifest.options_ui?.page).toBe('options/index.html');
    expect(manifest.permissions).toContain('offscreen');
    expect(manifest.incognito).toBe('spanning');
    expect(manifest.action?.default_popup).toBeUndefined();
    expect(manifest.browser_specific_settings).toBeUndefined();
    const war = (manifest as { web_accessible_resources?: unknown }).web_accessible_resources;
    expect(JSON.stringify(war)).not.toContain('<all_urls>');
    expect(JSON.stringify(war)).toContain('i18n/locales/*');
    expect(JSON.stringify(war)).toContain('i18n/schema/*');
  });

  it('builds a firefox manifest with firefox-only overrides', () => {
    const manifest = createBrowserManifest('firefox');
    const manifestWithSharedFields = manifest as {
      name?: string;
      description?: string;
      background?: {
        scripts?: string[];
        service_worker?: string;
      };
    };

    expect(manifest.action?.default_popup).toBeUndefined();
    expect(manifestWithSharedFields.name).toBe('__MSG_extName__');
    expect(manifestWithSharedFields.description).toBe('__MSG_extDescription__');
    expect(manifestWithSharedFields.background).toEqual({
      scripts: ['background/index.js']
    });
    expect(manifestWithSharedFields.background?.service_worker).toBeUndefined();
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['<all_urls>'],
        js: ['content/index.js'],
        run_at: 'document_end'
      }
    ]);
    expect(manifest.permissions).not.toContain('offscreen');
    expect(manifest.browser_specific_settings?.gecko?.id).toBe('zendio@sxnian.com');
    expect(manifest.browser_specific_settings?.gecko?.strict_min_version).toBe('142.0');
    expect(manifest.browser_specific_settings?.gecko?.data_collection_permissions).toEqual({
      required: ['none'],
      optional: ['technicalAndInteraction']
    });
    expect(manifest.browser_specific_settings?.gecko_android?.strict_min_version).toBe('142.0');
    expect(manifest.incognito).toBeUndefined();
  });

  it('allows release metadata checks to evaluate a version from an isolated root', () => {
    const manifest = createBrowserManifest('chrome', { version: '9.8.7' });

    expect(manifest.version).toBe('9.8.7');
  });

  it('keeps public default manifests free of commercial storage and capture permissions', () => {
    const browsers: Array<'chrome' | 'firefox'> = ['chrome', 'firefox'];

    for (const browser of browsers) {
      const manifest = createBrowserManifest(browser);
      const manifestText = JSON.stringify(manifest);

      expect(manifestText).not.toContain('unlimitedStorage');
      expect(manifestText).not.toContain('message_serialization');
      expect(manifestText).not.toContain('tabCapture');
    }
  });
});
