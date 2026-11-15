import { apiFetch, getCsrfToken } from '../../api.js';

export type ClientMediaType = 'IMAGE' | 'AUDIO' | 'VIDEO';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export interface UploadEncryptedMediaInput {
  sessionId: string;
  recipientId: string;
  file: File;
  mediaType: ClientMediaType;
  isAdult?: boolean;
  senderConfirmed18Plus?: boolean;
  senderConfirmedConsent?: boolean;
  onProgress?: (percent: number) => void;
}

export async function uploadAndFinalizeEncryptedMedia(
  input: UploadEncryptedMediaInput
): Promise<{ mediaId: string; contentType: string; fileSize: number; verifiedMime: string }> {
  const contentType = input.file.type.split(';', 1)[0]?.trim();
  if (!contentType) {
    throw new Error('Không xác định được định dạng media.');
  }

  input.onProgress?.(5);

  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const fileIv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextWithTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fileIv }, dek, await input.file.arrayBuffer())
  );
  const ciphertext = ciphertextWithTag.slice(0, -16);
  const fileAuthTag = ciphertextWithTag.slice(-16);
  const rawDek = new Uint8Array(await crypto.subtle.exportKey('raw', dek));

  input.onProgress?.(20);

  let presignResponse: Response;
  try {
    presignResponse = await apiFetch('/api/v1/media/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: input.sessionId,
        recipientId: input.recipientId,
        contentType,
        fileSize: ciphertext.byteLength,
        mediaType: input.mediaType,
        dek: bytesToBase64(rawDek),
        iv: bytesToBase64(fileIv),
        authTag: bytesToBase64(fileAuthTag),
        isAdult: input.isAdult === true,
        senderConfirmed18Plus: input.senderConfirmed18Plus === true,
        senderConfirmedConsent: input.senderConfirmedConsent === true,
      }),
    });
  } finally {
    rawDek.fill(0);
  }

  const presign = (await presignResponse.json().catch(() => ({}))) as {
    mediaId?: string;
    media_id?: string;
    uploadUrl?: string;
    upload_url?: string;
    error?: string;
  };
  const mediaId = presign.mediaId || presign.media_id;
  const uploadUrl = presign.uploadUrl || presign.upload_url;
  if (!presignResponse.ok || !mediaId || !uploadUrl) {
    throw new Error(presign.error || 'Không thể cấp URL tải media.');
  }

  input.onProgress?.(30);

  // Upload ciphertext via XHR to support byte-level upload progress tracking
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('x-amz-meta-media-id', mediaId);
    const csrf = getCsrfToken();
    if (csrf) {
      xhr.setRequestHeader('X-CSRF-Token', csrf);
    }
    if (input.onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          const rawPct = event.loaded / event.total;
          const mapped = Math.min(92, Math.max(30, Math.round(30 + rawPct * 62)));
          input.onProgress?.(mapped);
        }
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Tải tệp lên máy chủ thất bại (HTTP ${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error('Lỗi kết nối mạng khi tải tệp lên.'));
    xhr.onabort = () => reject(new Error('Tải tệp bị hủy.'));
    xhr.send(ciphertext);
  });

  input.onProgress?.(95);

  const completeResponse = await apiFetch(`/api/v1/media/${encodeURIComponent(mediaId)}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const completeBody = (await completeResponse.json().catch(() => ({}))) as {
    mediaId?: string;
    fileSize?: number;
    verifiedMime?: string;
    error?: string;
  };
  if (!completeResponse.ok || !completeBody.verifiedMime) {
    throw new Error(completeBody.error || 'Máy chủ không xác thực được tệp media vừa tải lên.');
  }

  input.onProgress?.(100);

  return {
    mediaId,
    contentType: completeBody.verifiedMime,
    fileSize: completeBody.fileSize ?? input.file.size,
    verifiedMime: completeBody.verifiedMime,
  };
}

export async function fetchDecryptedMediaView(
  mediaId: string,
  fallbackContentType: string
): Promise<{
  previewUrl: string;
  watermarkText: string;
  watermarkedMode: 'embedded' | 'overlay';
  expiresIn: number;
}> {
  type ViewTokenPayload = {
    status?: string;
    retryAfterMs?: number;
    message?: string;
    view_token?: string;
    dek?: string;
    watermark_text?: string;
    iv?: string;
    auth_tag?: string;
    content_type?: string;
    expires_in?: number;
    error?: string;
  };

  let view: ViewTokenPayload = {};
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const viewResponse = await apiFetch(`/api/v1/media/${encodeURIComponent(mediaId)}/view-token`);
    view = (await viewResponse.json().catch(() => ({}))) as ViewTokenPayload;
    if (viewResponse.status === 202 || view.status === 'PROCESSING') {
      const waitMs = Math.min(Math.max(view.retryAfterMs || 1500, 500), 5000);
      await new Promise((resolve) => window.setTimeout(resolve, waitMs));
      continue;
    }
    if (!viewResponse.ok || !view.view_token || !view.dek) {
      throw new Error(view.error || view.message || 'Không thể cấp quyền xem media.');
    }
    break;
  }
  if (!view.view_token || !view.dek) {
    throw new Error('Quá thời gian xử lý video watermark ở máy chủ. Vui lòng thử lại.');
  }

  const streamResponse = await apiFetch(`/api/v1/media/stream/${encodeURIComponent(mediaId)}`, {
    headers: { 'X-Media-View-Token': view.view_token },
  });
  if (!streamResponse.ok) {
    const errBody = (await streamResponse.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error || 'Media đã hết hạn hoặc bị thu hồi.');
  }

  const ivHeader = streamResponse.headers.get('X-Media-Iv') || view.iv || '';
  const tagHeader = streamResponse.headers.get('X-Media-Auth-Tag') || view.auth_tag || '';
  const resolvedContentType =
    streamResponse.headers.get('X-Media-Content-Type') || view.content_type || fallbackContentType;
  const watermarkedMode =
    streamResponse.headers.get('X-Media-Watermarked') === 'embedded' ? 'embedded' : 'overlay';

  const ciphertext = await streamResponse.arrayBuffer();
  const rawDek = new Uint8Array(base64ToArrayBuffer(view.dek));
  let dek: CryptoKey;
  try {
    dek = await crypto.subtle.importKey('raw', rawDek, { name: 'AES-GCM' }, false, ['decrypt']);
  } finally {
    rawDek.fill(0);
  }

  const tag = new Uint8Array(base64ToArrayBuffer(tagHeader));
  const encryptedFile = new Uint8Array(ciphertext.byteLength + tag.byteLength);
  encryptedFile.set(new Uint8Array(ciphertext), 0);
  encryptedFile.set(tag, ciphertext.byteLength);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToArrayBuffer(ivHeader) },
    dek,
    encryptedFile.buffer
  );

  const previewUrl = URL.createObjectURL(new Blob([plaintext], { type: resolvedContentType }));
  return {
    previewUrl,
    watermarkText: view.watermark_text || 'Chatible Protected View',
    watermarkedMode,
    expiresIn: view.expires_in ?? 300,
  };
}

export async function revokeMediaAsset(mediaId: string): Promise<void> {
  const response = await apiFetch(`/api/v1/media/${encodeURIComponent(mediaId)}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error || 'Không thể thu hồi media.');
  }
}

export type ServerMediaRevocationState = 'revoked' | 'active' | 'unknown';

/**
 * Queries the authoritative server status of a media asset to reconcile UI/lifecycle state
 * if a revoke request fails or times out over the network.
 */
export async function fetchMediaRevocationStatus(mediaId: string): Promise<ServerMediaRevocationState> {
  try {
    const response = await apiFetch(`/api/v1/media/${encodeURIComponent(mediaId)}/status`, {
      cache: 'no-store',
    });
    if (response.status === 404 || response.status === 410) {
      return 'revoked';
    }
    if (!response.ok) {
      return 'unknown';
    }
    const body = (await response.json().catch(() => ({}))) as { revoked?: boolean; expired?: boolean };
    return body.revoked || body.expired ? 'revoked' : 'active';
  } catch {
    return 'unknown';
  }
}
