import { describe, expect, it, vi } from 'vitest';
import {
  writeIntoDirectory,
  type FileSystemDirectoryHandleLike,
  type FileSystemFileHandleLike,
  type FileSystemWritableFileStreamLike
} from '../../../../src/platform/chrome/localVaultCore';

function createWritable(): {
  handle: FileSystemWritableFileStreamLike;
  write: ReturnType<typeof vi.fn<FileSystemWritableFileStreamLike['write']>>;
  close: ReturnType<typeof vi.fn<FileSystemWritableFileStreamLike['close']>>;
} {
  const write = vi.fn<FileSystemWritableFileStreamLike['write']>(() => Promise.resolve());
  const close = vi.fn<FileSystemWritableFileStreamLike['close']>(() => Promise.resolve());
  return {
    handle: { write, close },
    write,
    close
  };
}

function createFileHandle(writable = createWritable().handle): FileSystemFileHandleLike {
  return {
    createWritable: vi.fn(() => Promise.resolve(writable))
  };
}

function createDirectoryHandle(name: string): {
  handle: FileSystemDirectoryHandleLike;
  getDirectoryHandle: ReturnType<typeof vi.fn<FileSystemDirectoryHandleLike['getDirectoryHandle']>>;
  getFileHandle: ReturnType<typeof vi.fn<FileSystemDirectoryHandleLike['getFileHandle']>>;
} {
  const getDirectoryHandle = vi.fn<FileSystemDirectoryHandleLike['getDirectoryHandle']>(() =>
    Promise.resolve(createDirectoryHandle('child').handle)
  );
  const getFileHandle = vi.fn<FileSystemDirectoryHandleLike['getFileHandle']>(() =>
    Promise.resolve(createFileHandle())
  );
  return {
    handle: { name, getDirectoryHandle, getFileHandle },
    getDirectoryHandle,
    getFileHandle
  };
}

describe('localVaultCore writeIntoDirectory', () => {
  it.each(['../escape.md', 'folder/../escape.md'])(
    'rejects unsafe traversal path %j before touching directory handles',
    async (filePath) => {
      const root = createDirectoryHandle('Vault');

      await expect(writeIntoDirectory(root.handle, filePath, 'content')).rejects.toThrow(
        'Vault-relative path must not contain traversal segments.'
      );

      expect(root.getDirectoryHandle).not.toHaveBeenCalled();
      expect(root.getFileHandle).not.toHaveBeenCalled();
    }
  );

  it('strips one matching vault prefix when the selected root policy is provided', async () => {
    const writable = createWritable();
    const fileHandle = createFileHandle(writable.handle);
    const rootGetDirectoryHandle = vi.fn<FileSystemDirectoryHandleLike['getDirectoryHandle']>(() =>
      Promise.reject(new Error('unexpected nested directory'))
    );
    const rootGetFileHandle = vi.fn<FileSystemDirectoryHandleLike['getFileHandle']>(() =>
      Promise.resolve(fileHandle)
    );
    const root: FileSystemDirectoryHandleLike = {
      name: 'Vault',
      getDirectoryHandle: rootGetDirectoryHandle,
      getFileHandle: rootGetFileHandle
    };

    await writeIntoDirectory(root, 'Vault/safe.md', 'content', { selectedVaultName: 'Vault' });

    expect(rootGetDirectoryHandle).not.toHaveBeenCalled();
    expect(rootGetFileHandle).toHaveBeenCalledWith('safe.md', { create: true });
    expect(writable.write).toHaveBeenCalledWith('content');
  });

  it('keeps a vault-name-like first segment without a selected root policy', async () => {
    const writable = createWritable();
    const fileHandle = createFileHandle(writable.handle);
    const vaultGetDirectoryHandle = vi.fn<FileSystemDirectoryHandleLike['getDirectoryHandle']>(() =>
      Promise.reject(new Error('unexpected nested directory'))
    );
    const vaultGetFileHandle = vi.fn<FileSystemDirectoryHandleLike['getFileHandle']>(() =>
      Promise.resolve(fileHandle)
    );
    const vaultDirectory: FileSystemDirectoryHandleLike = {
      name: 'Vault',
      getDirectoryHandle: vaultGetDirectoryHandle,
      getFileHandle: vaultGetFileHandle
    };
    const rootGetDirectoryHandle = vi.fn<FileSystemDirectoryHandleLike['getDirectoryHandle']>(() =>
      Promise.resolve(vaultDirectory)
    );
    const rootGetFileHandle = vi.fn<FileSystemDirectoryHandleLike['getFileHandle']>(() =>
      Promise.reject(new Error('unexpected root file write'))
    );
    const root: FileSystemDirectoryHandleLike = {
      name: 'Root',
      getDirectoryHandle: rootGetDirectoryHandle,
      getFileHandle: rootGetFileHandle
    };

    await writeIntoDirectory(root, 'Vault/safe.md', 'content');

    expect(rootGetDirectoryHandle).toHaveBeenCalledWith('Vault', { create: true });
    expect(vaultGetFileHandle).toHaveBeenCalledWith('safe.md', { create: true });
    expect(writable.write).toHaveBeenCalledWith('content');
  });

  it('preserves nonmatching selected root prefixes', async () => {
    const writable = createWritable();
    const fileHandle = createFileHandle(writable.handle);
    const rootGetDirectoryHandle = vi.fn<FileSystemDirectoryHandleLike['getDirectoryHandle']>(() =>
      Promise.resolve({
        name: 'vault',
        getDirectoryHandle: vi.fn(() => Promise.reject(new Error('unexpected nested directory'))),
        getFileHandle: vi.fn(() => Promise.resolve(fileHandle))
      })
    );
    const rootGetFileHandle = vi.fn<FileSystemDirectoryHandleLike['getFileHandle']>(() =>
      Promise.reject(new Error('unexpected root file write'))
    );
    const root: FileSystemDirectoryHandleLike = {
      name: 'Vault',
      getDirectoryHandle: rootGetDirectoryHandle,
      getFileHandle: rootGetFileHandle
    };

    await writeIntoDirectory(root, 'vault/safe.md', 'content', { selectedVaultName: 'Vault' });

    expect(rootGetDirectoryHandle).toHaveBeenCalledWith('vault', { create: true });
    expect(writable.write).toHaveBeenCalledWith('content');
  });
});
