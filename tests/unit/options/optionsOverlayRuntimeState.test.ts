/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOptionsOverlayRuntimeState,
  type OptionsOverlayRuntimeStatePort
} from '@options/app/optionsOverlayRuntimeState';
import { mountProductionStitchShell } from '@options/app/productionStitchShell';
import { createProductionStitchShellMutableState } from '@options/app/productionStitchShellMutableState';
import { getFooterMeta, getFooterView, getSettingsView } from '@options/stitch/schema/registry';
import { previewContent } from '@options/stitch/content';
import type { PreviewContent, SchemaContext } from '@options/stitch/types';
import {
  asOptionsController,
  createController,
  flushPromises,
  setupProductionStitchShellTest
} from './productionStitchShell.helpers';

type OverlaySnapshot = Record<string, unknown> & {
  ownerStatus: { state: string };
};

describe('Options overlay runtime state', () => {
  beforeEach(setupProductionStitchShellTest);

  it('updates durable state and notifies only when snapshot identity changes', () => {
    const initial: OverlaySnapshot = { ownerStatus: { state: 'initial' } };
    const next: OverlaySnapshot = { ownerStatus: { state: 'active' } };
    const state = createOptionsOverlayRuntimeState(initial);
    const listener = vi.fn();
    const unsubscribe = state.subscribe(listener);

    state.setSnapshot(initial);
    expect(listener).not.toHaveBeenCalled();

    state.setSnapshot(next);
    expect(state.getSnapshot()).toBe(next);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(next);

    unsubscribe();
    state.setSnapshot({ ownerStatus: { state: 'after-cleanup' } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('serializes reentrant updates so every listener observes 1 then 2 consistently', () => {
    const state = createOptionsOverlayRuntimeState(0);
    const firstObservations: Array<[number, number]> = [];
    const secondObservations: Array<[number, number]> = [];

    state.subscribe((value) => {
      firstObservations.push([value, state.getSnapshot()]);
      if (value === 1) {
        state.setSnapshot(2);
      }
    });
    state.subscribe((value) => {
      secondObservations.push([value, state.getSnapshot()]);
    });

    state.setSnapshot(1);

    expect(firstObservations).toEqual([
      [1, 1],
      [2, 2]
    ]);
    expect(secondObservations).toEqual([
      [1, 1],
      [2, 2]
    ]);
  });

  it('keeps public core app data authoritative while accepting neutral overlay keys', () => {
    const overlayRuntimeState = createOptionsOverlayRuntimeState({
      ownerStatus: { state: 'active' },
      nav: []
    });
    const shellState = createProductionStitchShellMutableState({
      previewContent,
      language: 'en',
      messages: null,
      overlayRuntimeState
    });
    const appData = shellState.getAppData() as PreviewContent & OverlaySnapshot;

    expect(appData.ownerStatus).toEqual({ state: 'active' });
    expect(appData.nav).toEqual(previewContent.nav);
  });

  it('rerenders async updates, preserves them across localized copies and refresh, then unsubscribes on cleanup', async () => {
    const initial: OverlaySnapshot = { ownerStatus: { state: 'initial' } };
    const active: OverlaySnapshot = { ownerStatus: { state: 'active' } };
    const afterCleanup: OverlaySnapshot = { ownerStatus: { state: 'after-cleanup' } };
    const overlayRuntimeState: OptionsOverlayRuntimeStatePort<OverlaySnapshot> =
      createOptionsOverlayRuntimeState(initial);
    const seenAppData: Array<PreviewContent & OverlaySnapshot> = [];
    const getSettingsViewWithOverlay = vi.fn((id: string, context: SchemaContext) => {
      seenAppData.push(context.appData as PreviewContent & OverlaySnapshot);
      return getSettingsView(id, context);
    });
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(createController()),
      initialOptions: null,
      messages: null,
      language: 'en',
      previewContent,
      getFooterMeta,
      getFooterView,
      getSettingsView: getSettingsViewWithOverlay,
      overlayRuntimeState
    });

    expect(seenAppData.at(-1)?.ownerStatus).toEqual({ state: 'initial' });

    queueMicrotask(() => overlayRuntimeState.setSnapshot(active));
    await flushPromises();

    const renderCallsAfterAsyncUpdate = getSettingsViewWithOverlay.mock.calls.length;
    expect(renderCallsAfterAsyncUpdate).toBeGreaterThan(1);
    expect(seenAppData.at(-1)?.ownerStatus).toEqual({ state: 'active' });
    expect(new Set(seenAppData.slice(-2)).size).toBe(2);

    mounted.refreshOptions({ rest: { vault: 'Overlay Vault' } });
    expect(seenAppData.at(-1)?.ownerStatus).toEqual({ state: 'active' });

    mounted.cleanup();
    const callsAfterCleanup = getSettingsViewWithOverlay.mock.calls.length;
    overlayRuntimeState.setSnapshot(afterCleanup);
    await flushPromises();
    expect(getSettingsViewWithOverlay).toHaveBeenCalledTimes(callsAfterCleanup);
  });
});
