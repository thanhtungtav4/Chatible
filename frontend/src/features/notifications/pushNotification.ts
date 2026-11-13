import { apiFetch } from '../../api.js';

let cachedStealthMode = false;
let isStealthSynced = false;

/**
 * Syncs the authoritative stealth mode status from the server
 */
export async function syncStealthState(): Promise<boolean> {
  try {
    const res = await apiFetch('/api/v1/users/me/stealth-vault');
    if (res.ok) {
      const data = (await res.json()) as { enabled?: boolean };
      cachedStealthMode = Boolean(data.enabled);
      try {
        localStorage.setItem('chatible_stealth_mode', String(cachedStealthMode));
      } catch {}
      isStealthSynced = true;
      return cachedStealthMode;
    }
  } catch {}

  // Fallback to localStorage if offline or network error
  try {
    cachedStealthMode = localStorage.getItem('chatible_stealth_mode') === 'true';
  } catch {}
  return cachedStealthMode;
}

/**
 * Updates the local stealth mode cache immediately (e.g. upon user toggle)
 */
export function setLocalStealthMode(enabled: boolean): void {
  cachedStealthMode = enabled;
  try {
    localStorage.setItem('chatible_stealth_mode', String(enabled));
  } catch {}
}

/**
 * Checks whether stealth mode is currently active
 */
export function getLocalStealthMode(): boolean {
  if (!isStealthSynced) {
    try {
      cachedStealthMode = localStorage.getItem('chatible_stealth_mode') === 'true';
    } catch {}
  }
  return cachedStealthMode;
}

/**
 * Checks if browser supports Notification API
 */
export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Gets current notification permission
 */
export function getNotificationPermission(): NotificationPermission {
  if (!isNotificationSupported()) return 'denied';
  return Notification.permission;
}

/**
 * Requests notification permission from user
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!isNotificationSupported()) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  try {
    const perm = await Notification.requestPermission();
    return perm;
  } catch {
    return 'denied';
  }
}

export interface PushNotificationPayload {
  title?: string;
  content: string;
  senderName?: string;
  type: 'CHAT' | 'FRIEND' | 'GROUP' | 'SYSTEM' | 'MATCH';
  tag?: string;
  url?: string;
  force?: boolean;
}

/**
 * Triggers a push notification taking Stealth Mode into account:
 * - Khi bật ngụy trang (Stealth ON): hiển thị thông báo trung tính "Bạn có 1 thông báo mới", ẩn trích đoạn & người gửi.
 * - Khi không bật ngụy trang (Stealth OFF): hiển thị tên người gửi và trích đoạn tin nhắn mới.
 */
export async function triggerPushNotification(payload: PushNotificationPayload): Promise<void> {
  if (!isNotificationSupported() || Notification.permission !== 'granted') return;

  // Only trigger if document is hidden or not focused (unless forced)
  const isDocumentHidden =
    typeof document !== 'undefined' &&
    (document.visibilityState === 'hidden' || !document.hasFocus());
  if (!isDocumentHidden && !payload.force) {
    return;
  }

  const isStealth = getLocalStealthMode();

  let displayTitle = '';
  let displayBody = '';
  const displayIcon = '/favicon.svg';

  if (isStealth) {
    // KHI BẬT NGỤY TRANG:
    // Tuyệt đối không để lộ tên người gửi, trích đoạn tin nhắn hay ngữ cảnh chat
    displayTitle = 'Thông báo hệ thống';
    displayBody = 'Bạn có 1 thông báo mới.';
  } else {
    // KHI KHÔNG BẬT NGỤY TRANG:
    // Hiển thị tên người gửi và trích đoạn nội dung tin nhắn mới
    const rawContent = payload.content.trim();
    const snippet = rawContent.length > 80 ? `${rawContent.slice(0, 77)}...` : rawContent;

    switch (payload.type) {
      case 'CHAT':
        displayTitle = payload.senderName ? `Tin nhắn từ ${payload.senderName}` : 'Tin nhắn mới';
        displayBody = snippet || 'Bạn nhận được một tin nhắn mới.';
        break;
      case 'FRIEND':
        displayTitle = payload.senderName ? `${payload.senderName} (Bạn bè)` : 'Tin nhắn từ bạn bè';
        displayBody = snippet || 'Bạn nhận được một tin nhắn mới.';
        break;
      case 'GROUP':
        displayTitle = payload.title ? `${payload.title}` : 'Tin nhắn phòng cộng đồng';
        displayBody = payload.senderName ? `${payload.senderName}: ${snippet}` : snippet;
        break;
      case 'MATCH':
        displayTitle = 'Chatible — Đã ghép đôi!';
        displayBody = snippet || 'Đã tìm thấy một người bạn mới phù hợp.';
        break;
      case 'SYSTEM':
      default:
        displayTitle = payload.title || 'Chatible — Thông báo hệ thống';
        displayBody = snippet;
        break;
    }
  }

  // 1. Use ServiceWorker registration when available
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if (reg && 'showNotification' in reg) {
        await reg.showNotification(displayTitle, {
          body: displayBody,
          icon: displayIcon,
          badge: displayIcon,
          tag: payload.tag || `chatible-${payload.type}`,
          renotify: true,
          data: { url: payload.url || '/' },
        });
        return;
      }
    }
  } catch {}

  // 2. Fallback to standard Notification API
  try {
    const notif = new Notification(displayTitle, {
      body: displayBody,
      icon: displayIcon,
      badge: displayIcon,
      tag: payload.tag || `chatible-${payload.type}`,
    });
    notif.onclick = () => {
      window.focus();
      notif.close();
    };
  } catch {}
}
