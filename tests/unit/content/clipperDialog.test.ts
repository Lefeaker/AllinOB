/* @vitest-environment jsdom */

import type { PageI18nController, Messages, I18nBinder } from '../../../src/i18n';
import type { StorageAreaService, StorageService } from '../../../src/platform/interfaces/storage';
import type { ClipperDialogDependencies } from '@content/clipper/components/dialogDependencies';

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { setWindowProp, asType } from '../../utils/typeHelpers';
import { MockClipRepository } from '../../utils/repositories';
import { getTestRestUrls } from '../../fixtures/configTestHelpers';

type I18nContextModule = typeof import('../../../src/content/i18n/context');
type StyleSheetManagerModule =
  typeof import('../../../src/content/clipper/shared/styleSheetManager');

const LOCAL_REST_URLS = getTestRestUrls('localhost');
const LOCAL_REST_BASE_URL = LOCAL_REST_URLS.baseUrl.replace(/\/$/, '');
const LOCAL_REST_HTTPS_URL = LOCAL_REST_URLS.httpsUrl.replace(/\/$/, '');
const LOCAL_REST_HTTP_URL = LOCAL_REST_URLS.httpUrl.replace(/\/$/, '');

const initializeStylesMock =
  vi.fn<
    (
      ...args: Parameters<StyleSheetManagerModule['clipperStyleSheetManager']['initialize']>
    ) => ReturnType<StyleSheetManagerModule['clipperStyleSheetManager']['initialize']>
  >();
const applyStylesMock =
  vi.fn<
    (
      ...args: Parameters<StyleSheetManagerModule['clipperStyleSheetManager']['applyTo']>
    ) => ReturnType<StyleSheetManagerModule['clipperStyleSheetManager']['applyTo']>
  >();
const applyStitchRuntimeStylesMock = vi.fn();
const ensureContentI18nMock =
  vi.fn<
    (
      ...args: Parameters<I18nContextModule['ensureContentI18n']>
    ) => ReturnType<I18nContextModule['ensureContentI18n']>
  >();
const getContentI18nBinderMock =
  vi.fn<
    (
      ...args: Parameters<I18nContextModule['getContentI18nBinder']>
    ) => ReturnType<I18nContextModule['getContentI18nBinder']>
  >();
const getContentMessagesMock =
  vi.fn<
    (
      ...args: Parameters<I18nContextModule['getContentMessages']>
    ) => ReturnType<I18nContextModule['getContentMessages']>
  >();

vi.mock('../../../src/content/i18n/context', () => ({
  ensureContentI18n: ensureContentI18nMock,
  getContentI18nBinder: getContentI18nBinderMock,
  getContentMessages: getContentMessagesMock
}));

vi.mock('../../../src/content/clipper/shared/styleSheetManager', () => ({
  clipperStyleSheetManager: {
    initialize: initializeStylesMock,
    applyTo: applyStylesMock,
    applyStitchRuntimeStyles: applyStitchRuntimeStylesMock
  },
  supportsAdoptedStyleSheets: () => true
}));

vi.mock('../../../src/content/clipper/components/commentForm', async () => {
  const actual = await vi.importActual<typeof import('@content/clipper/components/commentForm')>(
    '@content/clipper/components/commentForm'
  );
  return actual;
});

const dialogMessages = {
  clipDialogTitle: 'Clip Selection',
  clipDialogInstructions:
    'Use Tab to move between controls. Press Alt + Arrow keys to reposition the dialog.',
  cancelButton: 'Cancel',
  clipButton: 'Save',
  commentLabel: 'Comment',
  commentPlaceholder: 'Add a note',
  openReaderButton: 'Open reader',
  addToReaderButton: 'Add to reader',
  openVideoModeButton: 'Enter video mode'
};

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));
const expectDialogResult = (result: unknown, expected: { action: string; comment: string }) => {
  expect(result).toEqual({
    ...expected,
    destination: { kind: 'downloads' }
  });
};
const getHost = () => document.getElementById('obsidian-clipper-dialog');
const getDialogRoot = () => {
  const host = getHost();
  if (!host) {
    return null;
  }
  return host.shadowRoot ?? host;
};
const getActiveElement = () => {
  const host = getHost();
  if (host?.shadowRoot) {
    return host.shadowRoot.activeElement ?? host.shadowRoot;
  }
  return document.activeElement;
};

const createStorageAreaStub = (): StorageAreaService => ({
  get: vi.fn(() => Promise.resolve(undefined)),
  getAll: vi.fn(() => Promise.resolve({})),
  set: vi.fn(() => Promise.resolve(undefined)),
  getMany: vi.fn(() => Promise.resolve({})),
  setMany: vi.fn(() => Promise.resolve(undefined)),
  remove: vi.fn(() => Promise.resolve(undefined)),
  clear: vi.fn(() => Promise.resolve(undefined)),
  watchKey: vi.fn(() => () => undefined),
  watchAll: vi.fn(() => () => undefined)
});

const createDialogDeps = (
  overrides: { keyboardShortcutsEnabled?: boolean } = {}
): Partial<ClipperDialogDependencies> => {
  const clipRepo = new MockClipRepository();
  if ('keyboardShortcutsEnabled' in overrides) {
    void clipRepo.setFragmentConfig({
      keyboardShortcutsEnabled: overrides.keyboardShortcutsEnabled as boolean
    });
  }
  const storage: StorageService = {
    local: createStorageAreaStub(),
    sync: createStorageAreaStub()
  };

  return {
    clipRepo,
    optionsRepository: {
      get: vi.fn(() =>
        Promise.resolve({
          rest: {
            rootDir: '',
            vault: 'Test Vault',
            baseUrl: '',
            apiKey: ''
          },
          vaultRouter: {
            defaultVaultId: 'default',
            vaults: [],
            rules: []
          }
        })
      ),
      set: vi.fn(() => Promise.resolve()),
      onChange: vi.fn(() => () => undefined)
    } as unknown as ClipperDialogDependencies['optionsRepository'],
    storage,
    runtime: {
      getURL: vi.fn((path: string) => path)
    } as unknown as ClipperDialogDependencies['runtime'],
    errorHandler: {
      handle: vi.fn(() => Promise.resolve(undefined))
    } as unknown as ClipperDialogDependencies['errorHandler']
  };
};

function createVaultOptions() {
  return {
    rest: {
      rootDir: '',
      vault: 'Default Vault',
      baseUrl: LOCAL_REST_BASE_URL,
      apiKey: 'token'
    },
    templates: {
      article: 'Articles/{{title}}.md',
      fragment: 'Fragments/{{title}}.md',
      reading: 'Readings/{{title}}.md',
      ai: 'AI/{{title}}.md'
    },
    domainMappings: {},
    vaultRouter: {
      defaultVaultId: 'default',
      vaults: [
        {
          id: 'default',
          name: 'Default Vault',
          vault: 'Default Vault',
          httpsUrl: LOCAL_REST_HTTPS_URL,
          httpUrl: LOCAL_REST_HTTP_URL,
          apiKey: 'token',
          enabled: true,
          isDefault: true
        },
        {
          id: 'research',
          name: 'Research Vault',
          vault: 'Research Vault',
          httpsUrl: 'https://localhost:27125',
          httpUrl: 'http://localhost:27122',
          apiKey: 'token',
          enabled: true
        }
      ],
      rules: []
    }
  };
}

beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') {
    class TestPointerEvent extends MouseEvent {
      constructor(type: string, init?: PointerEventInit) {
        super(type, init);
      }
    }
    setWindowProp('PointerEvent', asType<typeof PointerEvent>(TestPointerEvent));
  }
});

describe('ClipperDialog UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureContentI18nMock.mockResolvedValue(asType<PageI18nController>(undefined));
    getContentI18nBinderMock.mockReturnValue(null);
    getContentMessagesMock.mockResolvedValue(dialogMessages as Messages);
    initializeStylesMock.mockResolvedValue(undefined);
    applyStylesMock.mockResolvedValue(undefined);
    applyStitchRuntimeStylesMock.mockReturnValue(undefined);
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('resolves with trimmed comment on confirm and removes dialog', async () => {
    const { ClipperDialog } = await import('../../../src/content/clipper/components/dialog');
    const dialog = new ClipperDialog(createDialogDeps());

    const resultPromise = dialog.show('Hello world');
    await flushPromises();

    const host = getHost();
    const shadow = getDialogRoot();
    expect(host?.getAttribute('role')).toBe('dialog');
    expect(host?.getAttribute('aria-modal')).toBe('true');
    expect(shadow).not.toBeNull();

    const textarea = shadow?.querySelector<HTMLTextAreaElement>('#clipper-comment-input') ?? null;
    expect(textarea).not.toBeNull();
    if (!textarea) throw new Error('textarea missing');
    expect(getActiveElement()).toBe(textarea);
    expect(textarea.classList.contains('clipper-comment-textarea')).toBe(true);
    expect(textarea.hasAttribute('style')).toBe(false);

    textarea.value = '  note  ';
    const confirmBtn = shadow?.querySelector<HTMLButtonElement>('[data-action-id="clip"]');
    expect(confirmBtn).toBeTruthy();
    if (!confirmBtn) throw new Error('confirm button missing');
    confirmBtn.click();

    const result = await resultPromise;
    expectDialogResult(result, { action: 'clip', comment: 'note' });
    expect(document.getElementById('obsidian-clipper-dialog')).toBeNull();
  });

  it('builds presenter command buttons and comment hooks from element helpers', async () => {
    const { buildDialogPresenter } =
      await import('../../../src/content/clipper/components/dialogPresenterElements');
    const handlers = {
      reader: vi.fn(),
      video: vi.fn(),
      cancel: vi.fn(),
      confirm: vi.fn()
    };
    const getFallback = <Key extends keyof Messages>(key: Key): string =>
      (dialogMessages[key as keyof typeof dialogMessages] as string | undefined) ?? String(key);

    const presenter = buildDialogPresenter({
      selectedText: 'Selected text',
      initialComment: 'Initial note',
      allowReaderMode: true,
      allowVideoMode: true,
      readerModeBehavior: 'start',
      binder: null,
      getFallback,
      resolveAssetUrl: (path) => `chrome-extension://test/${path}`,
      bindings: {
        applyText: (element, key, fallback) => {
          element.dataset.i18n = key;
          element.textContent = fallback;
        },
        applyAttr: (element, attribute, datasetKey, key, fallback) => {
          element.setAttribute(attribute, fallback);
          (element.dataset as Record<string, string>)[datasetKey] = key;
        }
      },
      registerI18nHandles: vi.fn(),
      onReader: handlers.reader,
      onVideo: handlers.video,
      onCancel: handlers.cancel,
      onConfirm: handlers.confirm
    });

    document.body.append(presenter.content);

    expect(presenter.header.querySelector('.clipper-dialog-title')).toBeTruthy();
    expect(presenter.textarea.value).toBe('Initial note');
    expect(presenter.textarea.getAttribute('aria-label')).toBe('Comment');
    expect(presenter.hintElement).toBe(
      presenter.content.querySelector('.clipper-comment-completed-hint')
    );

    const buttons = Array.from(presenter.content.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Open reader',
      'Enter video mode',
      'Cancel',
      'Save'
    ]);

    buttons.forEach((button) => button.click());
    expect(handlers.reader).toHaveBeenCalledTimes(1);
    expect(handlers.video).toHaveBeenCalledTimes(1);
    expect(handlers.cancel).toHaveBeenCalledTimes(1);
    expect(handlers.confirm).toHaveBeenCalledTimes(1);
  });

  it('resolves with cancelled status when overlay clicked', async () => {
    const { ClipperDialog } = await import('../../../src/content/clipper/components/dialog');
    const dialog = new ClipperDialog(createDialogDeps());

    const resultPromise = dialog.show('Selection');
    await flushPromises();

    const overlay = getDialogRoot()?.querySelector<HTMLElement>('.resource-modal-overlay');
    expect(overlay).toBeTruthy();
    if (!overlay) throw new Error('overlay missing');
    overlay.click();

    const result = await resultPromise;
    expectDialogResult(result, { action: 'cancel', comment: '' });
    expect(document.getElementById('obsidian-clipper-dialog')).toBeNull();
  });

  it('updates dialog position when dragged', async () => {
    const { ClipperDialog } = await import('../../../src/content/clipper/components/dialog');
    const dialog = new ClipperDialog(createDialogDeps());

    const promise = dialog.show('Another selection');
    await flushPromises();

    const shadow = getDialogRoot();
    const container = shadow?.querySelector<HTMLElement>('.resource-modal') ?? null;
    expect(container).not.toBeNull();
    if (!container) throw new Error('dialog container missing');

    const header = container.querySelector<HTMLElement>('.clipper-dialog-header');
    expect(header).not.toBeNull();
    if (!header) throw new Error('dialog header missing');

    const initialTransform = container.style.transform;

    header.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 230, clientY: 240 }));
    document.dispatchEvent(new PointerEvent('pointerup', {}));

    const transform = container.style.transform;
    expect(transform).toMatch(/translate\(/);
    expect(transform).not.toBe(initialTransform);

    // resolve pending promise to avoid dangling handlers
    const primaryButton = shadow?.querySelector<HTMLButtonElement>('[data-action-id="clip"]');
    if (primaryButton) {
      primaryButton.click();
      await promise;
    }
  });

  it('closes on Escape and restores previous focus', async () => {
    const focusTarget = document.createElement('button');
    document.body.appendChild(focusTarget);
    focusTarget.focus();

    const { ClipperDialog } = await import('../../../src/content/clipper/components/dialog');
    const dialog = new ClipperDialog(createDialogDeps());

    const resultPromise = dialog.show('Escape me');
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    const result = await resultPromise;
    expectDialogResult(result, { action: 'cancel', comment: '' });
    await flushPromises();
    expect(document.activeElement).toBe(focusTarget);
  });

  it('traps focus within the dialog when tabbing', async () => {
    const { ClipperDialog } = await import('../../../src/content/clipper/components/dialog');
    const dialog = new ClipperDialog(createDialogDeps());

    const promise = dialog.show('Focus sample');
    await flushPromises();

    const shadow = getDialogRoot();
    const shadowRoot = shadow instanceof ShadowRoot ? shadow : null;
    const textarea = shadow?.querySelector<HTMLTextAreaElement>('#clipper-comment-input') ?? null;
    expect(textarea).not.toBeNull();
    const confirmBtn = shadow?.querySelector<HTMLButtonElement>('[data-action-id="clip"]');
    expect(confirmBtn).toBeTruthy();
    confirmBtn?.focus();

    confirmBtn?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    );
    expect(shadowRoot?.activeElement).not.toBeNull();

    textarea?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    );
    expect(shadowRoot?.activeElement).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await promise;
  });

  it('supports keyboard repositioning with Alt + Arrow keys', async () => {
    const { ClipperDialog } = await import('../../../src/content/clipper/components/dialog');
    const dialog = new ClipperDialog(createDialogDeps());

    const promise = dialog.show('Keyboard move');
    await flushPromises();

    const container = getDialogRoot()?.querySelector<HTMLElement>('.resource-modal') ?? null;
    expect(container).not.toBeNull();
    if (!container) throw new Error('dialog container missing');

    const initialTransform = container.style.transform;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true }));
    const afterTransform = container.style.transform;
    expect(afterTransform).toMatch(/translate\(/);
    expect(afterTransform).not.toBe(initialTransform);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await promise;
  });

  it('returns the selected destination when entering reader mode', async () => {
    const { ClipperDialog } = await import('../../../src/content/clipper/components/dialog');
    const deps = createDialogDeps();
    const optionsRepository = deps.optionsRepository;
    if (!optionsRepository) {
      throw new Error('options repository missing');
    }
    vi.mocked(optionsRepository.get).mockResolvedValue(createVaultOptions() as never);
    const dialog = new ClipperDialog(deps);

    const promise = dialog.show('Reader destination');
    await flushPromises();

    const shadow = getDialogRoot();
    const researchOption = shadow?.querySelector<HTMLButtonElement>(
      '.export-destination-option[data-destination-id="research"]'
    );
    expect(researchOption).toBeTruthy();
    researchOption?.click();
    await flushPromises();

    shadow?.querySelector<HTMLButtonElement>('[data-action-id="reader"]')?.click();

    await expect(promise).resolves.toEqual({
      action: 'reader',
      comment: '',
      destination: { kind: 'vault', vaultId: 'research' }
    });
  });

  it('renders comment form with class-based styles only', async () => {
    const { ClipperDialog } = await import('../../../src/content/clipper/components/dialog');
    const dialog = new ClipperDialog(createDialogDeps());

    const promise = dialog.show('Styled selection');
    await flushPromises();

    const shadow = getDialogRoot();
    const form = shadow?.querySelector<HTMLElement>('.clipper-comment-form');
    expect(form).toBeTruthy();
    expect(form?.hasAttribute('style')).toBe(false);

    const label = form?.querySelector('.clipper-comment-label');
    const textarea = form?.querySelector('.clipper-comment-textarea');

    expect(form?.querySelector('.clipper-comment-preview')).toBeNull();
    expect(label).toBeNull();
    expect(textarea).toBeTruthy();
    expect(textarea?.getAttribute('aria-label')).toBe('Comment');

    expect(textarea?.hasAttribute('style')).toBe(false);

    const nestedStyles = form?.querySelectorAll('style');
    expect(nestedStyles?.length ?? 0).toBe(0);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await promise;
  });

  it('binds dialog text via i18n binder when available', async () => {
    const textHandles: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    const attrHandles: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    const binder = {
      bindText: vi.fn(() => {
        const handle = { dispose: vi.fn() };
        textHandles.push(handle);
        return handle;
      }),
      bindAttr: vi.fn(() => {
        const handle = { dispose: vi.fn() };
        attrHandles.push(handle);
        return handle;
      })
    };
    getContentI18nBinderMock.mockReturnValue(binder as unknown as I18nBinder);

    const { ClipperDialog } = await import('../../../src/content/clipper/components/dialog');
    const dialog = new ClipperDialog(createDialogDeps());

    const resultPromise = dialog.show('Localized');
    await flushPromises();

    expect(binder.bindText).toHaveBeenCalledWith(expect.any(HTMLElement), 'clipDialogTitle');
    expect(binder.bindText).toHaveBeenCalledWith(expect.any(HTMLElement), 'clipDialogInstructions');
    expect(binder.bindText).toHaveBeenCalledWith(expect.any(HTMLElement), 'clipButton');
    expect(binder.bindText).toHaveBeenCalledWith(expect.any(HTMLElement), 'openReaderButton');
    expect(binder.bindAttr).toHaveBeenCalledWith(
      expect.any(HTMLTextAreaElement),
      'aria-label',
      'commentLabel'
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await resultPromise;

    for (const handle of [...textHandles, ...attrHandles]) {
      expect(handle.dispose).toHaveBeenCalled();
    }
  });
});

describe('ClipperDialog repository integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureContentI18nMock.mockResolvedValue(undefined as unknown as PageI18nController);
    getContentI18nBinderMock.mockReturnValue(null);
    getContentMessagesMock.mockResolvedValue(dialogMessages as unknown as Messages);
    initializeStylesMock.mockResolvedValue(undefined);
    applyStylesMock.mockResolvedValue(undefined);
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('subscribes to fragment config changes on show and unsubscribes on destroy', async () => {
    const { ClipperDialog } = await import('../../../src/content/clipper/components/dialog');
    const deps = createDialogDeps();
    if (!deps.clipRepo) {
      throw new Error('clipRepo missing');
    }
    const dialog = new ClipperDialog(deps);

    void dialog.show('Repo subscription');
    await flushPromises();

    const listeners = (deps.clipRepo as unknown as { listeners: Set<unknown> }).listeners;
    expect(listeners.size).toBe(1);

    dialog.destroy();
    expect(listeners.size).toBe(0);
  });

  it('updates internal shortcut state when fragment config changes', async () => {
    const { ClipperDialog } = await import('../../../src/content/clipper/components/dialog');
    const deps = createDialogDeps();
    if (!deps.clipRepo) {
      throw new Error('clipRepo missing');
    }
    await deps.clipRepo.setFragmentConfig({ keyboardShortcutsEnabled: false });

    const dialog = new ClipperDialog(deps);
    void dialog.show('Shortcut config');
    await flushPromises();

    const state = dialog as unknown as { keyboardShortcutsEnabled: boolean };
    expect(state.keyboardShortcutsEnabled).toBe(false);

    await deps.clipRepo.setFragmentConfig({ keyboardShortcutsEnabled: true });
    expect(state.keyboardShortcutsEnabled).toBe(true);

    dialog.destroy();
  });
});
