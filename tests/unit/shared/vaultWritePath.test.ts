import { describe, expect, it } from 'vitest';
import {
  encodeVaultWritePath,
  normalizeLocalFolderWritePath,
  normalizeRestWritePath,
  normalizeVaultWritePath
} from '../../../src/shared/paths/vaultWritePath';

describe('vault write path contract', () => {
  it.each([
    ['Inbox/file.md', 'Inbox/file.md'],
    ['/Inbox/file.md', 'Inbox/file.md'],
    ['Inbox\\nested\\file.md', 'Inbox/nested/file.md'],
    [' Inbox / nested / file.md ', 'Inbox/nested/file.md']
  ])('normalizes safe write path %j', (input, expected) => {
    expect(normalizeVaultWritePath(input).path).toBe(expected);
  });

  it.each(['../escape.md', 'folder/../escape.md', 'folder/./file.md'])(
    'rejects traversal write path %j',
    (input) => {
      expect(() => normalizeVaultWritePath(input)).toThrow(
        'Vault-relative path must not contain traversal segments.'
      );
    }
  );

  it('rejects empty paths by default', () => {
    expect(() => normalizeVaultWritePath('')).toThrow('Vault-relative path must not be empty.');
  });

  it('allows empty paths when explicitly requested', () => {
    expect(normalizeVaultWritePath('/', { allowEmpty: true })).toEqual({
      path: '',
      strippedVaultPrefix: false
    });
  });

  it.each([
    ['Vault/Inbox/file.md', 'Inbox/file.md'],
    ['/Vault/Inbox/file.md', 'Inbox/file.md']
  ])('strips one exact matching vault prefix for REST write path %j', (input, expected) => {
    expect(normalizeRestWritePath(input, 'Vault')).toEqual({
      path: expected,
      strippedVaultPrefix: true
    });
  });

  it('preserves case-mismatched vault-like prefixes for REST writes', () => {
    expect(normalizeRestWritePath('vault/Inbox/file.md', 'Vault')).toEqual({
      path: 'vault/Inbox/file.md',
      strippedVaultPrefix: false
    });
  });

  it('strips at most one matching vault prefix for REST writes', () => {
    expect(normalizeRestWritePath('Vault/Vault/Inbox/file.md', 'Vault')).toEqual({
      path: 'Vault/Inbox/file.md',
      strippedVaultPrefix: true
    });
  });

  it('preserves matching first segments for Local Folder writes without a selected root policy', () => {
    expect(normalizeLocalFolderWritePath('Vault/Inbox/file.md')).toEqual({
      path: 'Vault/Inbox/file.md',
      strippedVaultPrefix: false
    });
  });

  it('strips one exact matching vault prefix for Local Folder selected-root writes', () => {
    expect(
      normalizeLocalFolderWritePath('Vault/Inbox/file.md', { selectedVaultName: 'Vault' })
    ).toEqual({
      path: 'Inbox/file.md',
      strippedVaultPrefix: true
    });
  });

  it('preserves case-mismatched local-folder selected-root prefixes', () => {
    expect(
      normalizeLocalFolderWritePath('vault/Inbox/file.md', { selectedVaultName: 'Vault' })
    ).toEqual({
      path: 'vault/Inbox/file.md',
      strippedVaultPrefix: false
    });
  });

  it('strips at most one matching vault prefix for Local Folder selected-root writes', () => {
    expect(
      normalizeLocalFolderWritePath('Vault/Vault/Inbox/file.md', {
        selectedVaultName: 'Vault'
      })
    ).toEqual({
      path: 'Vault/Inbox/file.md',
      strippedVaultPrefix: true
    });
  });

  it('encodes each write path segment without encoding separators', () => {
    expect(encodeVaultWritePath('Inbox/file with spaces/日本語.md')).toBe(
      'Inbox/file%20with%20spaces/%E6%97%A5%E6%9C%AC%E8%AA%9E.md'
    );
  });
});
