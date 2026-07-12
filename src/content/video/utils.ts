export type VideoPlatform = 'bilibili' | 'youtube' | 'unknown';

export interface VideoIdentity {
  platform: VideoPlatform;
  videoId: string | null;
  storageKey: string | null;
  canonicalUrl: string;
}

export const VIDEO_STORAGE_PREFIX: Record<Exclude<VideoPlatform, 'unknown'>, string> = {
  bilibili: 'bili:',
  youtube: 'yt:'
};

export function isLegacyVideoStorageKey(key: string): boolean {
  return Object.values(VIDEO_STORAGE_PREFIX).some(
    (prefix) => key.startsWith(prefix) && key.length > prefix.length
  );
}

export function detectVideoIdentity(rawUrl: string | undefined | null): VideoIdentity {
  const fallbackIdentity: VideoIdentity = {
    platform: 'unknown',
    videoId: null,
    storageKey: null,
    canonicalUrl: rawUrl || ''
  };

  if (!rawUrl) {
    return fallbackIdentity;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return fallbackIdentity;
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname.includes('bilibili.com')) {
    const match = parsed.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    const videoId = match ? match[1] : null;
    const canonical = (() => {
      if (!videoId) {
        return parsed.href;
      }
      const base = new URL(`https://www.bilibili.com/video/${videoId}`);
      const p = parsed.searchParams.get('p');
      if (p) {
        base.searchParams.set('p', p);
      }
      return base.toString();
    })();

    return {
      platform: 'bilibili',
      videoId,
      storageKey: videoId ? `${VIDEO_STORAGE_PREFIX.bilibili}${videoId}` : null,
      canonicalUrl: canonical
    };
  }

  if (hostname.includes('youtube.com') || hostname === 'youtu.be') {
    let videoId: string | null = null;

    if (hostname === 'youtu.be') {
      const trimmed = parsed.pathname.replace(/^\/+/, '');
      videoId = trimmed ? trimmed.split(/[?/]/)[0] : null;
    } else {
      videoId = parsed.searchParams.get('v');
      if (!videoId && parsed.pathname.startsWith('/shorts/')) {
        const parts = parsed.pathname.split('/');
        videoId = parts[2] ?? null;
      }
      if (!videoId && parsed.pathname.startsWith('/embed/')) {
        const parts = parsed.pathname.split('/');
        videoId = parts[2] ?? null;
      }
    }

    const canonical = (() => {
      if (!videoId) {
        return parsed.href;
      }
      const base = new URL(`https://www.youtube.com/watch?v=${videoId}`);
      const listId = parsed.searchParams.get('list');
      if (listId) {
        base.searchParams.set('list', listId);
      }
      return base.toString();
    })();

    return {
      platform: 'youtube',
      videoId,
      storageKey: videoId ? `${VIDEO_STORAGE_PREFIX.youtube}${videoId}` : null,
      canonicalUrl: canonical
    };
  }

  return fallbackIdentity;
}

export function isSupportedVideoUrl(rawUrl: string | undefined | null): boolean {
  return detectVideoIdentity(rawUrl).platform !== 'unknown';
}
