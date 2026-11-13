import {
  MediaError,
  type MediaAssetRow,
  type MediaRepository,
  type MediaType,
  type SessionRow,
} from './media.types.js';

/**
 * Encapsulates authorization, block checks, participant validation,
 * media/adult 18+ consent policies, and deliverable media verification.
 */
export class MediaPolicyHelper {
  constructor(private readonly repository: MediaRepository) {}

  async assertUserActive(userId: string): Promise<void> {
    if (this.repository.getUserStatus) {
      const status = await this.repository.getUserStatus(userId);
      if (status && (status === 'RESTRICTED' || status === 'DELETED')) {
        throw new MediaError(403, 'Tài khoản đã bị khóa hoặc đình chỉ do vi phạm chính sách cộng đồng.');
      }
    }
  }

  async sessionForParticipant(sessionId: string, userId: string): Promise<SessionRow> {
    const session = await this.repository.getSession(sessionId);
    if (!session || (session.userAId !== userId && session.userBId !== userId)) {
      throw new MediaError(403, 'Bạn không thuộc phiên trò chuyện này.');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new MediaError(410, 'Phiên trò chuyện đã hết hạn.');
    }
    return session;
  }

  otherParticipant(session: SessionRow, userId: string): string {
    if (session.userAId === userId) return session.userBId;
    if (session.userBId === userId) return session.userAId;
    throw new MediaError(403, 'Bạn không thuộc phiên trò chuyện này.');
  }

  async assertNotBlocked(userAId: string, userBId: string): Promise<void> {
    if (this.repository.isBlocked && (await this.repository.isBlocked(userAId, userBId))) {
      throw new MediaError(403, 'Không thể gửi hoặc xem media vì tồn tại trạng thái chặn giữa hai tài khoản.');
    }
  }

  async consentIsValid(sessionId: string, recipientId: string, session?: SessionRow): Promise<boolean> {
    const targetSession = session ?? (await this.repository.getSession(sessionId));
    if (!targetSession) return false;
    if (targetSession.sessionType === 'FRIEND') {
      const other = targetSession.userAId === recipientId ? targetSession.userBId : targetSession.userAId;
      if (this.repository.isBlocked && (await this.repository.isBlocked(recipientId, other))) return false;
      if (this.repository.areFriends) {
        return this.repository.areFriends(recipientId, other);
      }
      return true;
    }
    const consent = await this.repository.getConsent(sessionId, recipientId);
    return consent?.enabled === true;
  }

  async adultConsentIsValid(sessionId: string, recipientId: string): Promise<boolean> {
    if (!this.repository.getAdultConsent) return false;
    const consent = await this.repository.getAdultConsent(sessionId, recipientId);
    return consent?.enabled === true;
  }

  async setConsent(
    userId: string,
    sessionId: string,
    enabled: boolean,
    requestedRecipientId?: string
  ): Promise<void> {
    await this.assertUserActive(userId);
    const session = await this.sessionForParticipant(sessionId, userId);
    if (requestedRecipientId && requestedRecipientId !== userId) {
      throw new MediaError(403, 'Chỉ người nhận mới có thể thay đổi quyền nhận media.');
    }
    this.otherParticipant(session, userId);
    await this.repository.upsertConsent(sessionId, userId, enabled);
  }

  async setAdultConsent(
    userId: string,
    sessionId: string,
    enabled: boolean,
    policyAcknowledged = false,
    requestedRecipientId?: string
  ): Promise<void> {
    await this.assertUserActive(userId);
    const session = await this.sessionForParticipant(sessionId, userId);
    if (requestedRecipientId && requestedRecipientId !== userId) {
      throw new MediaError(403, 'Chỉ người nhận mới có thể thay đổi quyền nhận nội dung nhạy cảm.');
    }
    this.otherParticipant(session, userId);
    if (enabled && !policyAcknowledged) {
      throw new MediaError(
        400,
        'Bạn cần xác nhận đã hiểu chính sách nội dung 18+ và giới hạn không thể chống chụp màn hình trước khi bật.'
      );
    }
    if (!this.repository.upsertAdultConsent) {
      throw new MediaError(501, 'Kho lưu trữ chưa hỗ trợ cấu hình đồng thuận nội dung nhạy cảm.');
    }
    await this.repository.upsertAdultConsent(sessionId, userId, enabled, policyAcknowledged);
  }

  async getConsentState(
    userId: string,
    sessionId: string
  ): Promise<{
    myMediaConsent: boolean;
    partnerMediaConsent: boolean;
    myAdultConsent: boolean;
    partnerAdultConsent: boolean;
  }> {
    await this.assertUserActive(userId);
    const session = await this.sessionForParticipant(sessionId, userId);
    const partnerId = this.otherParticipant(session, userId);
    const [myMediaConsent, partnerMediaConsent, myAdultConsent, partnerAdultConsent] = await Promise.all([
      this.consentIsValid(sessionId, userId, session),
      this.consentIsValid(sessionId, partnerId, session),
      this.adultConsentIsValid(sessionId, userId),
      this.adultConsentIsValid(sessionId, partnerId),
    ]);
    return { myMediaConsent, partnerMediaConsent, myAdultConsent, partnerAdultConsent };
  }

  async verifyDeliverableMedia(input: {
    mediaId: string;
    sessionId: string;
    senderId: string;
    recipientId: string;
    mediaType: MediaType;
    isAdultContent: boolean;
  }): Promise<MediaAssetRow> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.mediaId)) {
      throw new MediaError(400, 'Mã media không hợp lệ.');
    }
    const asset = await this.repository.getAsset(input.mediaId);
    if (!asset || asset.revokedAt || asset.expiresAt.getTime() <= Date.now()) {
      throw new MediaError(404, 'Media không tồn tại, đã thu hồi hoặc hết hạn.');
    }
    if (asset.status !== 'READY') {
      throw new MediaError(409, 'Media chưa hoàn tất xác thực tải lên.');
    }
    if (
      asset.sessionId !== input.sessionId ||
      asset.ownerId !== input.senderId ||
      asset.recipientId !== input.recipientId
    ) {
      throw new MediaError(403, 'Media không khớp người gửi, người nhận hoặc phiên trò chuyện.');
    }
    if (asset.mediaType !== input.mediaType) {
      throw new MediaError(400, 'Loại media tin nhắn không khớp với tệp đã tải lên.');
    }
    if (asset.isAdult !== input.isAdultContent) {
      throw new MediaError(400, 'Cờ nội dung người lớn (18+) không khớp với media đã xác thực.');
    }

    const session = await this.sessionForParticipant(input.sessionId, input.senderId);
    if (!(await this.consentIsValid(input.sessionId, input.recipientId, session))) {
      throw new MediaError(403, 'Người nhận đã tắt quyền nhận media.');
    }
    if (asset.isAdult) {
      if (!asset.senderConfirmed18Plus || !asset.senderConfirmedConsent) {
        throw new MediaError(403, 'Thiếu cam kết hợp pháp của người gửi cho nội dung 18+.');
      }
      if (!(await this.adultConsentIsValid(input.sessionId, input.recipientId))) {
        throw new MediaError(403, 'Người nhận đã tắt quyền nhận nội dung nhạy cảm (18+).');
      }
    }

    return asset;
  }
}
