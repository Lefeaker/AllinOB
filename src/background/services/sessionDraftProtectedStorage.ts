import type { StorageAreaService } from '../../platform/interfaces/storage';

export function createProtectedSessionDraftStorageArea(
  area: StorageAreaService,
  protectedKeys: ReadonlySet<string>
): StorageAreaService {
  return {
    ...area,
    remove(keyOrKeys) {
      const keys = (Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]).filter(
        (key) => !protectedKeys.has(key)
      );
      return keys.length > 0 ? area.remove(keys) : Promise.resolve();
    }
  };
}
