import { expect, test } from '@playwright/test';
import { attachBrowserDiagnostics, persistBrowserDiagnostics } from './utils/browserDiagnostics';

const BASE = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_SERVER_PORT ?? '4181'}`;

interface HarnessSnapshot {
  selection?: { id: string; name: string };
  files: Record<string, string>;
  restCalls: Array<{ filePath: string; contentType?: string }>;
}

interface HarnessWriteResult extends HarnessSnapshot {
  target: {
    storageTarget: 'local-folder' | 'rest-api';
    localFolderName?: string;
    fallbackReason?: string;
  };
  ok?: boolean;
  error?: string;
  code?: string;
}

interface HarnessApi {
  reset(): Promise<HarnessSnapshot>;
  chooseDirectory(): Promise<HarnessSnapshot>;
  writeMarkdown(filePath: string, markdown?: string): Promise<HarnessWriteResult>;
  writeWithDeniedPermission(): Promise<HarnessWriteResult>;
  writeAfterInlineReauthorization(): Promise<HarnessWriteResult & { reauthRequests: number }>;
  writeAfterInlineRestSuppression(): Promise<HarnessWriteResult & { reauthRequests: number }>;
  writeWithLocalFailure(): Promise<HarnessWriteResult>;
  writeTraversalPath(): Promise<HarnessWriteResult>;
}

declare global {
  interface Window {
    localVaultHarness: HarnessApi;
  }
}

test.describe('local vault write harness', () => {
  let diagnostics: ReturnType<typeof attachBrowserDiagnostics> | null = null;

  test.beforeEach(async ({ page }) => {
    diagnostics = attachBrowserDiagnostics(page);
    await page.goto(`${BASE}/local-vault-write-harness.html`);
    await expect(page.getByText('Harness ready')).toBeVisible();
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (diagnostics) {
      await persistBrowserDiagnostics(page, testInfo, diagnostics);
    }
    diagnostics = null;
  });

  test('saves selected local folder id and name', async ({ page }) => {
    const snapshot = await page.evaluate(async () => {
      await window.localVaultHarness.reset();
      return window.localVaultHarness.chooseDirectory();
    });

    expect(snapshot.selection?.id).toEqual(expect.any(String));
    expect(snapshot.selection?.id).not.toHaveLength(0);
    expect(snapshot.selection?.name).toBe('HarnessVault');
  });

  test('writes nested markdown paths into local folders', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.localVaultHarness.reset();
      await window.localVaultHarness.chooseDirectory();
      return window.localVaultHarness.writeMarkdown('Articles/foo/bar.md', '# nested');
    });

    expect(result.target).toMatchObject({
      storageTarget: 'local-folder',
      localFolderName: 'HarnessVault'
    });
    expect(result.files['Articles/foo/bar.md']).toBe('# nested');
    expect(result.restCalls).toEqual([]);
  });

  test('treats the configured vault prefix as the selected local folder root', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.localVaultHarness.reset();
      await window.localVaultHarness.chooseDirectory();
      return window.localVaultHarness.writeMarkdown('RemoteVault/Articles/root.md', '# root');
    });

    expect(result.target).toMatchObject({
      storageTarget: 'local-folder',
      localFolderName: 'HarnessVault'
    });
    expect(result.files['Articles/root.md']).toBe('# root');
    expect(result.files['RemoteVault/Articles/root.md']).toBeUndefined();
    expect(result.restCalls).toEqual([]);
  });

  test('rejects traversal paths without using REST fallback', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.localVaultHarness.reset();
      await window.localVaultHarness.chooseDirectory();
      return window.localVaultHarness.writeTraversalPath();
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('LOCAL_VAULT_WRITE_FAILED');
    expect(result.files).toEqual({});
    expect(result.restCalls).toEqual([]);
  });

  test('uses REST fallback when local permission is denied before writing', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.localVaultHarness.reset();
      await window.localVaultHarness.chooseDirectory();
      return window.localVaultHarness.writeWithDeniedPermission();
    });

    expect(result.target).toMatchObject({
      storageTarget: 'rest-api',
      localFolderName: 'HarnessVault',
      fallbackReason: 'permission-denied'
    });
    expect(result.files).toEqual({});
    expect(result.restCalls).toEqual([
      { filePath: 'Articles/fallback.md', contentType: 'text/markdown; charset=utf-8' }
    ]);
  });

  test('continues the same write locally after inline reauthorization grants permission', async ({
    page
  }) => {
    const result = await page.evaluate(async () => {
      await window.localVaultHarness.reset();
      await window.localVaultHarness.chooseDirectory();
      return window.localVaultHarness.writeAfterInlineReauthorization();
    });

    expect(result.reauthRequests).toBe(1);
    expect(result.target).toMatchObject({
      storageTarget: 'local-folder',
      localFolderName: 'HarnessVault'
    });
    expect(result.files['Articles/reauthorized.md']).toBe('# reauthorized');
    expect(result.restCalls).toEqual([]);
  });

  test('uses REST when inline reauthorization is declined without writing locally', async ({
    page
  }) => {
    const result = await page.evaluate(async () => {
      await window.localVaultHarness.reset();
      await window.localVaultHarness.chooseDirectory();
      return window.localVaultHarness.writeAfterInlineRestSuppression();
    });

    expect(result.reauthRequests).toBe(1);
    expect(result.target).toMatchObject({
      storageTarget: 'rest-api',
      localFolderName: 'HarnessVault',
      fallbackReason: 'permission-denied'
    });
    expect(result.files).toEqual({});
    expect(result.restCalls).toEqual([
      { filePath: 'Articles/rest-suppressed.md', contentType: 'text/markdown; charset=utf-8' }
    ]);
  });

  test('does not use REST fallback when local writing fails after preflight', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.localVaultHarness.reset();
      await window.localVaultHarness.chooseDirectory();
      return window.localVaultHarness.writeWithLocalFailure();
    });

    expect(result.ok).toBe(false);
    expect(result.target).toMatchObject({
      storageTarget: 'local-folder',
      localFolderName: 'HarnessVault'
    });
    expect(result.code).toBe('LOCAL_VAULT_WRITE_FAILED');
    expect(result.restCalls).toEqual([]);
  });
});
