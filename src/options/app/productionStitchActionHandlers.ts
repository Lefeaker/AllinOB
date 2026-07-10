import type { ActionRegistry } from '@options/schema-runtime/actionRuntime';
import type { PreviewContent, PreviewStoreState } from '@options/stitch/types';

export function readActionEventButton(value: unknown): HTMLButtonElement | null {
  return value instanceof Event && value.currentTarget instanceof HTMLButtonElement
    ? value.currentTarget
    : null;
}

export function sanitizeProductionStitchActionId(actionId: string): string {
  return actionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

export function mergeProductionStitchActionHandlers(
  productionHandlers: ActionRegistry<PreviewStoreState, PreviewContent>,
  additionalActionHandlers: ActionRegistry<PreviewStoreState, PreviewContent> | undefined
): ActionRegistry<PreviewStoreState, PreviewContent> {
  if (!additionalActionHandlers) {
    return productionHandlers;
  }

  const merged: ActionRegistry<PreviewStoreState, PreviewContent> = {
    ...productionHandlers
  };

  for (const [actionId, handler] of Object.entries(additionalActionHandlers)) {
    if (Object.prototype.hasOwnProperty.call(merged, actionId)) {
      console.warn(`[Options] Ignoring additional Stitch action handler for "${actionId}".`);
      continue;
    }
    merged[actionId] = handler;
  }

  return merged;
}
