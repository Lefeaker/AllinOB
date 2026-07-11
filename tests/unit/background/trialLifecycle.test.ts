import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asType, intervalId, partialOf, setGlobal } from '../../utils/typeHelpers';
import type { StorageAreaService } from '../../../src/platform/interfaces/storage';

const trackExtensionInstalledIfNeededMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve(undefined))
);

vi.mock('../../../src/background/services/analyticsEvents', () => ({
  trackExtensionInstalledIfNeeded: trackExtensionInstalledIfNeededMock
}));

function createStorageArea() {
  return {
    get: vi.fn(() => Promise.resolve(undefined)),
    getAll: vi.fn(() => Promise.resolve({})),
    set: vi.fn(() => Promise.resolve(undefined)),
    getMany: vi.fn(() => Promise.resolve({})),
    setMany: vi.fn(() => Promise.resolve(undefined)),
    remove: vi.fn(() => Promise.resolve(undefined)),
    clear: vi.fn(() => Promise.resolve(undefined)),
    watchKey: vi.fn(() => () => undefined),
    watchAll: vi.fn(() => () => undefined)
  } satisfies StorageAreaService;
}

describe('trialLifecycle', () => {
  const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('initializes trial config on first install and opens onboarding when needed', async () => {
    const { handleFirstInstall } = await import('../../../src/background/trialLifecycle');
    const initializeTrial = vi.fn(() => Promise.resolve(undefined));
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ trialDays: 14 })
      })
    );
    const tabsCreate = vi.fn(() => Promise.resolve(undefined));

    await handleFirstInstall(
      { reason: 'install' },
      {
        runtime: {
          getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
          onInstalled: vi.fn()
        },
        storage: {
          local: createStorageArea()
        },
        tabs: {
          create: tabsCreate
        },
        fetch: asType<typeof fetch>(fetchMock),
        initializeTrial
      }
    );

    expect(fetchMock).toHaveBeenCalledWith('chrome-extension://test/trial-config.json');
    expect(initializeTrial).toHaveBeenCalledWith(14);
    expect(trackExtensionInstalledIfNeededMock).toHaveBeenCalledTimes(1);
    expect(tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://test/onboarding/index.html'
    });
  });

  it('does not track an install event for update lifecycle reasons', async () => {
    const { handleFirstInstall } = await import('../../../src/background/trialLifecycle');

    await handleFirstInstall(
      { reason: 'update' },
      {
        runtime: {
          getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
          onInstalled: vi.fn()
        },
        storage: {
          local: createStorageArea()
        },
        tabs: {
          create: vi.fn(() => Promise.resolve(undefined))
        },
        fetch: asType<typeof fetch>(vi.fn()),
        initializeTrial: vi.fn(() => Promise.resolve(undefined))
      }
    );

    expect(trackExtensionInstalledIfNeededMock).not.toHaveBeenCalled();
  });

  it('skips trial initialization when trial-config fetch returns a non-ok response', async () => {
    const { initializeTrialOnInstall } = await import('../../../src/background/trialLifecycle');
    const initializeTrial = vi.fn(() => Promise.resolve(undefined));

    await initializeTrialOnInstall({
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`)
      },
      fetch: asType<typeof fetch>(
        vi.fn(() =>
          Promise.resolve({
            ok: false,
            status: 404
          })
        )
      ),
      initializeTrial
    });

    expect(initializeTrial).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[trial] trial-config.json request failed (404), skipping trial initialization'
    );
  });

  it('skips invalid trial-config payloads and logs a warning', async () => {
    const { initializeTrialOnInstall } = await import('../../../src/background/trialLifecycle');
    const initializeTrial = vi.fn(() => Promise.resolve(undefined));

    await initializeTrialOnInstall({
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`)
      },
      fetch: asType<typeof fetch>(
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ trialDays: 0 })
          })
        )
      ),
      initializeTrial
    });

    expect(initializeTrial).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[trial] trial-config.json is invalid, skipping trial initialization'
    );
  });

  it('treats thrown trial-config fetches as formal-version installs', async () => {
    const { initializeTrialOnInstall } = await import('../../../src/background/trialLifecycle');
    const initializeTrial = vi.fn(() => Promise.resolve(undefined));

    await initializeTrialOnInstall({
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`)
      },
      fetch: asType<typeof fetch>(vi.fn(() => Promise.reject(new Error('missing config')))),
      initializeTrial
    });

    expect(initializeTrial).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '[trial] Trial config not found, using the full version'
    );
  });

  it('registers installed and suspend lifecycle handlers', async () => {
    const { registerTrialLifecycle } = await import('../../../src/background/trialLifecycle');
    const onInstalled = vi.fn();
    const registerOnSuspend = vi.fn();

    registerTrialLifecycle({
      runtime: {
        getURL: vi.fn(),
        onInstalled
      },
      storage: asType({ local: { get: vi.fn() } }),
      tabs: asType({ create: vi.fn() }),
      fetch: asType<typeof fetch>(vi.fn()),
      initializeTrial: vi.fn(() => Promise.resolve(undefined)),
      checkTrialStatus: vi.fn(() =>
        Promise.resolve({
          isTrial: false,
          isExpired: false,
          remainingDays: Infinity,
          remainingHours: Infinity,
          expirationDate: null,
          isExpiringSoon: false
        })
      ),
      showExpirationNotice: vi.fn(() => Promise.resolve(undefined)),
      cleanupBackgroundDependencies: vi.fn(),
      registerOnSuspend,
      setInterval: asType<typeof setInterval>(vi.fn())
    });

    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(registerOnSuspend).toHaveBeenCalledTimes(1);
  });

  it('creates default suspend registration from the runtime service instead of global chrome', async () => {
    const restoreChrome = setGlobal(
      'chrome',
      partialOf<typeof chrome>({
        runtime: partialOf<typeof chrome.runtime>({
          onSuspend: partialOf<typeof chrome.runtime.onSuspend>({
            addListener: vi.fn(() => {
              throw new Error('global chrome onSuspend should not be used');
            })
          })
        })
      })
    );
    const { createDefaultTrialLifecycleDependencies } =
      await import('../../../src/background/trialLifecycle');
    const cleanup = vi.fn();
    const runtimeRegisterOnSuspend = vi.fn();
    const deps = createDefaultTrialLifecycleDependencies(
      partialOf({
        getURL: vi.fn(),
        onInstalled: vi.fn(),
        registerOnSuspend: runtimeRegisterOnSuspend
      }),
      { local: createStorageArea() },
      { create: vi.fn() }
    );

    deps.registerOnSuspend?.(cleanup);

    expect(runtimeRegisterOnSuspend).toHaveBeenCalledWith(cleanup);
    restoreChrome();
  });

  it('initializeTrialSystem notifies only for expiring/expired', async () => {
    const { initializeTrialSystem } = await import('../../../src/background/trialLifecycle');
    const showExpirationNotice = vi.fn(() => Promise.resolve(undefined));

    // Case 1: trial and expiring soon → notify once and schedule timer
    const checkTrialStatusExpiring = vi.fn(() =>
      Promise.resolve({
        isTrial: true,
        isExpired: false,
        remainingDays: 1,
        remainingHours: 12,
        expirationDate: null,
        isExpiringSoon: true
      })
    );
    const scheduled: Array<() => void> = [];
    const setIntervalStub = (cb: () => void) => {
      scheduled.push(cb);
      return intervalId(1);
    };

    await initializeTrialSystem({
      checkTrialStatus: checkTrialStatusExpiring,
      showExpirationNotice,
      setInterval: asType<typeof setInterval>(setIntervalStub)
    });

    expect(showExpirationNotice).toHaveBeenCalledTimes(1);
    expect(scheduled.length).toBe(1);

    // Trigger scheduled check: still expiring → notify again
    scheduled[0]();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(showExpirationNotice).toHaveBeenCalledTimes(2);

    // Case 2: trial but not expiring → no notify
    const checkTrialStatusOk = vi.fn(() =>
      Promise.resolve({
        isTrial: true,
        isExpired: false,
        remainingDays: 10,
        remainingHours: 240,
        expirationDate: null,
        isExpiringSoon: false
      })
    );
    showExpirationNotice.mockClear();
    await initializeTrialSystem({
      checkTrialStatus: checkTrialStatusOk,
      showExpirationNotice,
      setInterval: asType<typeof setInterval>(setIntervalStub)
    });
    expect(showExpirationNotice).not.toHaveBeenCalled();
  });

  it('logs scheduled trial status check failures without throwing', async () => {
    const { initializeTrialSystem } = await import('../../../src/background/trialLifecycle');
    const checkError = new Error('status failed');
    const checkTrialStatus = vi
      .fn()
      .mockResolvedValueOnce({
        isTrial: true,
        isExpired: false,
        remainingDays: 10,
        remainingHours: 240,
        expirationDate: null,
        isExpiringSoon: false
      })
      .mockRejectedValueOnce(checkError);
    const scheduled: Array<() => void> = [];

    await initializeTrialSystem({
      checkTrialStatus,
      showExpirationNotice: vi.fn(() => Promise.resolve(undefined)),
      setInterval: asType<typeof setInterval>((cb: () => void) => {
        scheduled.push(cb);
        return intervalId(1);
      })
    });
    scheduled[0]();

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[trial] Failed to perform scheduled status check:',
        checkError
      );
    });
  });

  it('logs scheduled trial notice failures without throwing', async () => {
    const { initializeTrialSystem } = await import('../../../src/background/trialLifecycle');
    const noticeError = new Error('notice failed');
    const checkTrialStatus = vi
      .fn()
      .mockResolvedValueOnce({
        isTrial: true,
        isExpired: false,
        remainingDays: 10,
        remainingHours: 240,
        expirationDate: null,
        isExpiringSoon: false
      })
      .mockResolvedValueOnce({
        isTrial: true,
        isExpired: true,
        remainingDays: 0,
        remainingHours: 0,
        expirationDate: null,
        isExpiringSoon: false
      });
    const showExpirationNotice = vi.fn(() => Promise.reject(noticeError));
    const scheduled: Array<() => void> = [];

    await initializeTrialSystem({
      checkTrialStatus,
      showExpirationNotice,
      setInterval: asType<typeof setInterval>((cb: () => void) => {
        scheduled.push(cb);
        return intervalId(1);
      })
    });
    scheduled[0]();

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[trial] Failed to perform scheduled status check:',
        noticeError
      );
    });
  });
});
