import type {
  LocalVaultDirectorySelection,
  LocalVaultPermissionState
} from '../interfaces/fileSystemAccess';
import { normalizeVaultRelativePath } from '../../shared/paths/vaultRelativePath';
import { normalizeLocalFolderWritePath } from '../../shared/paths/vaultWritePath';

export type PermissionMode = { mode: 'readwrite' };
export type FileSystemPermissionState = 'granted' | 'prompt' | 'denied';

export interface FileSystemWritableFileStreamLike {
  write(data: string | Blob | ArrayBuffer | Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface FileSystemFileHandleLike {
  createWritable(): Promise<FileSystemWritableFileStreamLike>;
}

export interface FileSystemDirectoryHandleLike {
  name: string;
  queryPermission?(descriptor?: PermissionMode): Promise<FileSystemPermissionState>;
  requestPermission?(descriptor?: PermissionMode): Promise<FileSystemPermissionState>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<FileSystemDirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandleLike>;
}

export interface StoredDirectoryHandle {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandleLike;
}

export type ShowDirectoryPicker = (options?: {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: string;
}) => Promise<FileSystemDirectoryHandleLike>;
export interface LocalVaultWritePathPolicy {
  selectedVaultName?: string;
}

const DB_NAME = 'ai2ob-local-vault-folders';
const DB_VERSION = 1;
const STORE_NAME = 'folders';
export const LOCAL_VAULT_PERMISSION: PermissionMode = { mode: 'readwrite' };

export function getShowDirectoryPicker(): ShowDirectoryPicker | undefined {
  const candidate = (globalThis as unknown as { showDirectoryPicker?: ShowDirectoryPicker })
    .showDirectoryPicker;
  return typeof candidate === 'function' ? candidate : undefined;
}

export function isLocalVaultStorageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function createFolderId(): string {
  const cryptoLike = globalThis.crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  return `local-vault-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to open local vault folder database.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onerror = () =>
        reject(request.error ?? new Error('Local vault folder database request failed.'));
      request.onsuccess = () => resolve(request.result);
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Local vault folder database transaction failed.'));
    });
  } finally {
    db.close();
  }
}

export async function putDirectoryHandle(entry: StoredDirectoryHandle): Promise<void> {
  await withStore('readwrite', (store) => store.put(entry));
}

export async function getDirectoryHandle(folderId: string): Promise<StoredDirectoryHandle | null> {
  const entry = await withStore<StoredDirectoryHandle | undefined>(
    'readonly',
    (store) => store.get(folderId) as IDBRequest<StoredDirectoryHandle | undefined>
  );
  return entry ?? null;
}

export async function deleteDirectoryHandle(folderId: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(folderId));
}

export async function ensureReadWritePermission(
  handle: FileSystemDirectoryHandleLike
): Promise<LocalVaultPermissionState> {
  const queried = await handle.queryPermission?.(LOCAL_VAULT_PERMISSION);
  if (queried === 'granted') {
    return 'granted';
  }
  const requested = await handle.requestPermission?.(LOCAL_VAULT_PERMISSION);
  if (requested === 'granted') {
    return 'granted';
  }
  return requested ?? queried ?? 'denied';
}

function normalizeRelativePath(filePath: string, policy: LocalVaultWritePathPolicy = {}): string[] {
  if (policy.selectedVaultName?.trim()) {
    return normalizeLocalFolderWritePath(filePath, policy).path.split('/');
  }
  return normalizeVaultRelativePath(filePath).split('/');
}

export async function chooseLocalVaultDirectory(options: {
  suggestedName?: string | undefined;
}): Promise<LocalVaultDirectorySelection> {
  const picker = getShowDirectoryPicker();
  if (!picker || !isLocalVaultStorageAvailable()) {
    throw new Error('File System Access API is not available in this browser.');
  }

  const handle = await picker({
    id: 'ai2ob-vault',
    mode: 'readwrite',
    ...(options.suggestedName ? { startIn: 'documents' } : {})
  });
  const permission = await ensureReadWritePermission(handle);
  if (permission !== 'granted') {
    throw new Error('Local vault folder permission was not granted.');
  }

  const entry: StoredDirectoryHandle = {
    id: createFolderId(),
    name: handle.name || options.suggestedName || 'Local Vault',
    handle
  };
  await putDirectoryHandle(entry);
  return { id: entry.id, name: entry.name };
}

export async function queryLocalVaultPermission(
  folderId: string
): Promise<LocalVaultPermissionState> {
  if (!isLocalVaultStorageAvailable()) {
    return 'unsupported';
  }
  const entry = await getDirectoryHandle(folderId);
  if (!entry) {
    return 'missing';
  }
  return entry.handle.queryPermission?.(LOCAL_VAULT_PERMISSION) ?? 'denied';
}

export async function ensureLocalVaultPermission(
  folderId: string
): Promise<LocalVaultPermissionState> {
  if (!isLocalVaultStorageAvailable()) {
    return 'unsupported';
  }
  const entry = await getDirectoryHandle(folderId);
  if (!entry) {
    return 'missing';
  }
  return ensureReadWritePermission(entry.handle);
}

export async function writeIntoDirectory(
  root: FileSystemDirectoryHandleLike,
  filePath: string,
  content: string | Blob | ArrayBuffer | Uint8Array,
  policy: LocalVaultWritePathPolicy = {}
): Promise<void> {
  const parts = normalizeRelativePath(filePath, policy);
  const fileName = parts.pop();
  if (!fileName) {
    throw new Error('Local vault file path is missing a file name.');
  }

  let directory = root;
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }

  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }
}

export async function writeLocalVaultFile(options: {
  folderId: string;
  filePath: string;
  content: string | Blob | ArrayBuffer | Uint8Array;
}): Promise<void> {
  if (!isLocalVaultStorageAvailable()) {
    throw new Error('File System Access storage is not available.');
  }
  const entry = await getDirectoryHandle(options.folderId);
  if (!entry) {
    throw new Error('Local vault folder is no longer available.');
  }
  const permission = await ensureReadWritePermission(entry.handle);
  if (permission !== 'granted') {
    throw new Error('Local vault folder permission was not granted.');
  }
  await writeIntoDirectory(entry.handle, options.filePath, options.content);
}
