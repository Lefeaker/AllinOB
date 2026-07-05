/* @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '@shared/config';
import type { StoredOptions, VaultRouterConfig } from '@shared/types';
import {
  applyRestBaseSectionSnapshot,
  collectAdditionalVaultConfigsCore,
  collectRestBaseChanges,
  collectRestBaseDraft,
  readRestRowValue,
  resolveDefaultVault
} from '@options/app/rest-settings/restSectionStateCore';

const defaults = DEFAULT_OPTIONS.rest;

function createInputs() {
  return {
    nameInput: document.createElement('input'),
    httpsInput: document.createElement('input'),
    httpInput: document.createElement('input'),
    apiKeyInput: document.createElement('input')
  };
}

describe('restSectionStateCore', () => {
  it('resolves the default vault from router default, explicit fallback, first vault, and empty state', () => {
    const vaults = [
      { id: 'one', vault: 'One', name: 'One', httpsUrl: '', httpUrl: '', apiKey: '', rules: [] },
      {
        id: 'two',
        vault: 'Two',
        name: 'Two',
        httpsUrl: '',
        httpUrl: '',
        apiKey: '',
        isDefault: true,
        rules: []
      }
    ];

    expect(resolveDefaultVault({ defaultVaultId: 'two', vaults, rules: [] }, 'one')?.id).toBe(
      'two'
    );
    expect(resolveDefaultVault({ vaults, rules: [] }, 'one')?.id).toBe('one');
    expect(resolveDefaultVault({ defaultVaultId: 'missing', vaults, rules: [] }, null)?.id).toBe(
      'one'
    );
    expect(resolveDefaultVault({ vaults: [], rules: [] }, null)).toBe(undefined);
    expect(resolveDefaultVault(null, null)).toBe(undefined);
  });

  it('applies default vault snapshots to present inputs while tolerating missing controls', () => {
    const inputs = createInputs();

    const resolved = applyRestBaseSectionSnapshot({
      options: { rest: { vault: 'StoredVault', apiKey: 'stored-key' } },
      defaultInputs: inputs,
      defaultVaultId: 'default',
      vaultRouterSnapshot: {
        defaultVaultId: 'default',
        vaults: [
          {
            id: 'default',
            vault: 'RouterVault',
            name: 'RouterVault',
            httpsUrl: 'https://router.example/',
            httpUrl: 'http://router.example/',
            apiKey: 'router-key',
            rules: []
          }
        ],
        rules: []
      },
      defaults
    });

    expect(resolved).toEqual({
      name: 'StoredVault',
      httpsUrl: 'https://router.example/',
      httpUrl: 'http://router.example/',
      apiKey: 'stored-key'
    });
    expect(inputs.nameInput.value).toBe('StoredVault');
    expect(inputs.httpsInput.value).toBe('https://router.example/');
    expect(inputs.httpInput.value).toBe('http://router.example/');
    expect(inputs.apiKeyInput.value).toBe('stored-key');

    expect(
      applyRestBaseSectionSnapshot({
        options: {},
        defaultInputs: {
          nameInput: null,
          httpsInput: null,
          httpInput: null,
          apiKeyInput: null
        },
        defaultVaultId: null,
        vaultRouterSnapshot: null,
        defaults
      }).name
    ).toBe(defaults.vault);
  });

  it('collects default vault changes and draft values without preserving hidden rootDir', () => {
    const inputs = createInputs();
    inputs.nameInput.value = '  DraftVault  ';
    inputs.httpsInput.value = '  https://draft.example/ ';
    inputs.httpInput.value = '';
    inputs.apiKeyInput.value = ' draft-key ';

    expect(
      collectRestBaseChanges({
        previous: { rest: { rootDir: 'LegacyRoot' } } as unknown as StoredOptions,
        defaultInputs: inputs,
        defaults
      })
    ).toEqual({
      rest: {
        baseUrl: 'https://draft.example/',
        vault: 'DraftVault',
        apiKey: ' draft-key ',
        httpsUrl: 'https://draft.example/'
      }
    });

    expect(collectRestBaseDraft(inputs)).toEqual({
      httpsUrl: 'https://draft.example/',
      vault: 'DraftVault',
      apiKey: ' draft-key ',
      baseUrl: 'https://draft.example/'
    });

    expect(
      collectRestBaseChanges({
        previous: null,
        defaultInputs: {
          nameInput: null,
          httpsInput: null,
          httpInput: null,
          apiKeyInput: null
        },
        defaults
      }).rest.baseUrl
    ).toBe(defaults.baseUrl);
    expect(collectRestBaseDraft(createInputs())).toEqual({});
  });

  it('reads row values safely with optional trimming', () => {
    const row = document.createElement('div');
    row.innerHTML = '<input class="trimmed" value="  value  "><input class="raw" value="  raw  ">';

    expect(readRestRowValue(row, '.trimmed')).toBe('value');
    expect(readRestRowValue(row, '.raw', false)).toBe('  raw  ');
    expect(readRestRowValue(row, '.missing')).toBeNull();
  });

  it('collects additional vault rows with local-folder handles, fallback, and filtering', () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <div data-vault-id="edited">
        <input class="rest-vault-enabled" type="checkbox" checked>
        <input class="rest-vault-name" value="Edited Vault">
        <input class="rest-vault-https" value="https://edited.example/">
        <input class="rest-vault-http" value="">
        <input class="rest-vault-api" value=" edited-key ">
        <button
          class="rest-vault-local-folder"
          data-local-folder-id="row-folder"
          data-local-folder-name="Row Folder"
        ></button>
      </div>
      <div data-vault-id="cleared">
        <input class="rest-vault-enabled" type="checkbox" checked>
        <button
          class="rest-vault-local-folder"
          data-local-folder-id=""
          data-local-folder-name=""
        ></button>
      </div>
      <div data-vault-id="disabled">
        <input class="rest-vault-enabled" type="checkbox">
      </div>
    `;
    const snapshot: VaultRouterConfig = {
      defaultVaultId: 'default',
      vaults: [
        {
          id: 'default',
          vault: 'Default',
          name: 'Default',
          httpsUrl: '',
          httpUrl: '',
          apiKey: '',
          rules: []
        },
        {
          id: 'edited',
          vault: 'Original',
          name: 'Original',
          httpsUrl: 'https://original.example/',
          httpUrl: 'http://original.example/',
          apiKey: 'original-key',
          rules: []
        },
        {
          id: 'cleared',
          vault: 'Cleared',
          name: 'Cleared',
          httpsUrl: '',
          httpUrl: '',
          apiKey: '',
          localFolderId: 'old-folder',
          localFolderName: 'Old Folder',
          rules: []
        },
        {
          id: 'missing-row',
          vault: 'Missing',
          name: 'Missing',
          httpsUrl: '',
          httpUrl: '',
          apiKey: '',
          enabled: true,
          localFolderId: 'missing-folder',
          localFolderName: 'Missing Folder',
          rules: []
        },
        {
          id: 'disabled',
          vault: 'Disabled',
          name: 'Disabled',
          httpsUrl: '',
          httpUrl: '',
          apiKey: '',
          enabled: true,
          rules: []
        }
      ],
      rules: []
    };

    expect(
      collectAdditionalVaultConfigsCore({
        additionalRowsHost: host,
        vaultRouterSnapshot: snapshot,
        defaultVaultId: null,
        includeLocalFolder: true
      })
    ).toEqual([
      {
        id: 'edited',
        vault: 'Edited Vault',
        name: 'Edited Vault',
        httpsUrl: 'https://edited.example/',
        httpUrl: '',
        apiKey: ' edited-key ',
        enabled: true,
        localFolderId: 'row-folder',
        localFolderName: 'Row Folder',
        rules: []
      },
      {
        id: 'cleared',
        vault: 'Cleared',
        name: 'Cleared',
        httpsUrl: '',
        httpUrl: '',
        apiKey: '',
        enabled: true,
        localFolderId: 'old-folder',
        localFolderName: 'Old Folder',
        rules: []
      },
      {
        id: 'missing-row',
        vault: 'Missing',
        name: 'Missing',
        httpsUrl: '',
        httpUrl: '',
        apiKey: '',
        enabled: true,
        localFolderId: 'missing-folder',
        localFolderName: 'Missing Folder',
        rules: []
      }
    ]);

    expect(
      collectAdditionalVaultConfigsCore({
        additionalRowsHost: null,
        vaultRouterSnapshot: null,
        defaultVaultId: null,
        includeLocalFolder: true
      })
    ).toEqual([]);
  });

  it('omits local-folder fields for widget-style collection', () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <div data-vault-id="edited">
        <input class="rest-vault-enabled" type="checkbox" checked>
        <button
          class="rest-vault-local-folder"
          data-local-folder-id="row-folder"
          data-local-folder-name="Row Folder"
        ></button>
      </div>
    `;
    const snapshot: VaultRouterConfig = {
      defaultVaultId: 'default',
      vaults: [
        {
          id: 'default',
          vault: 'Default',
          name: 'Default',
          httpsUrl: '',
          httpUrl: '',
          apiKey: '',
          rules: []
        },
        {
          id: 'edited',
          vault: 'Original',
          name: 'Original',
          httpsUrl: 'https://original.example/',
          httpUrl: '',
          apiKey: 'original-key',
          localFolderId: 'old-folder',
          localFolderName: 'Old Folder',
          rules: []
        }
      ],
      rules: []
    };

    const [vault] = collectAdditionalVaultConfigsCore({
      additionalRowsHost: host,
      vaultRouterSnapshot: snapshot,
      defaultVaultId: null,
      includeLocalFolder: false
    });

    expect(vault).toEqual(
      expect.objectContaining({
        id: 'edited',
        vault: 'Original',
        name: 'Original'
      })
    );
    expect(vault).not.toHaveProperty('localFolderId');
    expect(vault).not.toHaveProperty('localFolderName');
  });
});
