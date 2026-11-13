import nodemailer from 'nodemailer';
import { inArray } from 'drizzle-orm';
import { EncryptedPayload } from '@chatible/shared';
import { db } from '../database/index.js';
import { systemSettings } from '../database/schema/settings.js';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { createConfiguredKms } from '../kms/cloud-kms.service.js';

export const SMTP_PASSWORD_MASK = '********';
export const ENCRYPTED_SECRET_PREFIX = 'enc:v1:';

export const MAIL_SETTING_KEYS = [
  'mail.smtp.enabled',
  'mail.smtp.host',
  'mail.smtp.port',
  'mail.smtp.secure',
  'mail.smtp.user',
  'mail.smtp.password',
  'mail.smtp.from_name',
  'mail.smtp.from_address',
] as const;

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName: string;
  fromAddress: string;
}

export interface SmtpConfigOverride {
  enabled?: boolean | string;
  host?: string;
  port?: number | string;
  secure?: boolean | string;
  user?: string;
  password?: string;
  fromName?: string;
  fromAddress?: string;
}

export interface MailTransport {
  verify(): Promise<unknown>;
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<unknown>;
}

export type TransportFactory = (smtpConfig: SmtpConfig) => MailTransport;

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n"]/g, '').trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function defaultTransportFactory(smtpConfig: SmtpConfig): MailTransport {
  return nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth:
      smtpConfig.user || smtpConfig.password
        ? { user: smtpConfig.user, pass: smtpConfig.password }
        : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

export async function encryptSettingSecret(
  plaintext: string,
  cryptoService: EnvelopeCryptoService
): Promise<string> {
  if (!plaintext) return '';
  const payload = await cryptoService.encrypt(plaintext);
  return `${ENCRYPTED_SECRET_PREFIX}${JSON.stringify(payload)}`;
}

export async function decryptSettingSecret(
  stored: string,
  cryptoService: EnvelopeCryptoService
): Promise<string> {
  if (!stored) return '';
  if (!stored.startsWith(ENCRYPTED_SECRET_PREFIX)) {
    return stored;
  }
  const rawPayload = stored.slice(ENCRYPTED_SECRET_PREFIX.length);
  const parsed = JSON.parse(rawPayload) as EncryptedPayload;
  return cryptoService.decrypt(parsed);
}

export class MailService {
  private readonly cryptoService: EnvelopeCryptoService;
  private readonly transportFactory: TransportFactory;

  constructor(options?: {
    cryptoService?: EnvelopeCryptoService;
    transportFactory?: TransportFactory;
  }) {
    this.cryptoService =
      options?.cryptoService ?? new EnvelopeCryptoService(createConfiguredKms().kms);
    this.transportFactory = options?.transportFactory ?? defaultTransportFactory;
  }

  async getSmtpConfig(overrides?: SmtpConfigOverride): Promise<SmtpConfig> {
    const rows = await db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings)
      .where(inArray(systemSettings.key, [...MAIL_SETTING_KEYS]));

    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.key, row.value);
    }

    const storedPasswordRaw = map.get('mail.smtp.password') || '';
    const storedPassword = storedPasswordRaw
      ? await decryptSettingSecret(storedPasswordRaw, this.cryptoService)
      : '';

    const enabledRaw = overrides?.enabled ?? map.get('mail.smtp.enabled') ?? 'false';
    const enabled = enabledRaw === true || String(enabledRaw).toLowerCase() === 'true';

    const host = (overrides?.host ?? map.get('mail.smtp.host') ?? '').trim();
    const portRaw = overrides?.port ?? map.get('mail.smtp.port') ?? '587';
    const port = Number.parseInt(String(portRaw), 10) || 587;

    const secureRaw = overrides?.secure ?? map.get('mail.smtp.secure') ?? 'false';
    const secure = secureRaw === true || String(secureRaw).toLowerCase() === 'true';

    const user = (overrides?.user ?? map.get('mail.smtp.user') ?? '').trim();
    const password =
      overrides?.password === undefined || overrides.password === SMTP_PASSWORD_MASK
        ? storedPassword
        : overrides.password;

    const fromName =
      sanitizeHeaderValue(overrides?.fromName ?? map.get('mail.smtp.from_name') ?? 'Chatible Support') ||
      'Chatible Support';
    const fromAddress = sanitizeHeaderValue(
      overrides?.fromAddress ?? map.get('mail.smtp.from_address') ?? 'no-reply@chatible.app'
    );

    return {
      enabled,
      host,
      port,
      secure,
      user,
      password,
      fromName,
      fromAddress,
    };
  }

  async isMailEnabled(): Promise<boolean> {
    const cfg = await this.getSmtpConfig();
    return cfg.enabled && Boolean(cfg.host) && cfg.port >= 1 && cfg.port <= 65535;
  }

  private validateSmtpConfig(cfg: SmtpConfig): void {
    if (!cfg.host) {
      throw new Error('Vui lòng nhập SMTP Host (ví dụ: smtp.gmail.com).');
    }
    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
      throw new Error('Cổng SMTP không hợp lệ (phải từ 1 đến 65535).');
    }
    if (!cfg.fromAddress || !EMAIL_PATTERN.test(cfg.fromAddress)) {
      throw new Error('Email người gửi (From Address) không hợp lệ.');
    }
  }

  private formatFromHeader(cfg: SmtpConfig): string {
    const safeName = sanitizeHeaderValue(cfg.fromName);
    const safeAddr = sanitizeHeaderValue(cfg.fromAddress);
    return safeName ? `"${safeName}" <${safeAddr}>` : safeAddr;
  }

  async sendMail(
    message: { to: string; subject: string; text: string; html: string },
    configOverride?: SmtpConfig
  ): Promise<void> {
    const to = sanitizeHeaderValue(message.to);
    if (!EMAIL_PATTERN.test(to)) {
      throw new Error('Địa chỉ email người nhận không hợp lệ.');
    }

    const cfg = configOverride ?? (await this.getSmtpConfig());
    if (!cfg.enabled) {
      throw new Error('Dịch vụ gửi mail SMTP hiện đang tắt.');
    }
    this.validateSmtpConfig(cfg);

    const transport = this.transportFactory(cfg);
    await transport.sendMail({
      from: this.formatFromHeader(cfg),
      to,
      subject: message.subject.replace(/[\r\n]/g, ' ').trim(),
      text: message.text,
      html: message.html,
    });
  }

  async sendTestEmail(
    toEmail: string,
    formOverrides?: SmtpConfigOverride
  ): Promise<{ success: boolean; message: string }> {
    const cleanTo = sanitizeHeaderValue(toEmail || '');
    if (!EMAIL_PATTERN.test(cleanTo)) {
      throw new Error('Vui lòng nhập địa chỉ email nhận thử nghiệm hợp lệ.');
    }

    const cfg = await this.getSmtpConfig({ ...formOverrides, enabled: true });
    this.validateSmtpConfig(cfg);

    const transport = this.transportFactory(cfg);
    await transport.verify();

    const nowStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    await transport.sendMail({
      from: this.formatFromHeader(cfg),
      to: cleanTo,
      subject: '[Chatible] Kiểm tra kết nối SMTP thành công',
      text: `Xin chào Admin,\n\nCấu hình máy chủ gửi mail SMTP trên Chatible đã hoạt động bình thường.\nMáy chủ: ${cfg.host}:${cfg.port} (SSL: ${cfg.secure ? 'Bật' : 'Tắt'})\nThời gian kiểm tra: ${nowStr}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; background: #0f172a; color: #f8fafc; border-radius: 16px;">
          <div style="font-size: 20px; font-weight: 800; color: #38bdf8; margin-bottom: 12px;">Chatible Admin Control Deck</div>
          <p style="font-size: 14px; line-height: 1.6; color: #cbd5e1; margin: 0 0 16px;">
            Cấu hình máy chủ gửi mail <strong>SMTP</strong> của bạn đã được xác thực và hoạt động thành công.
          </p>
          <div style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 14px; font-size: 13px; color: #e2e8f0;">
            <div><strong>SMTP Host:</strong> ${escapeHtml(cfg.host)}:${cfg.port}</div>
            <div><strong>SSL/TLS:</strong> ${cfg.secure ? 'Bật' : 'STARTTLS / Tắt SSL trực tiếp'}</div>
            <div><strong>Người gửi:</strong> ${escapeHtml(cfg.fromName)} &lt;${escapeHtml(cfg.fromAddress)}&gt;</div>
            <div><strong>Thời gian:</strong> ${escapeHtml(nowStr)}</div>
          </div>
          <p style="font-size: 12px; color: #94a3b8; margin-top: 16px; margin-bottom: 0;">
            Email này được gửi từ tính năng Kiểm thử kết nối trong trang Quản trị Chatible.
          </p>
        </div>
      `,
    });

    return {
      success: true,
      message: `Đã gửi email thử nghiệm thành công tới ${cleanTo}.`,
    };
  }

  private renderChatibleEmailHtml(options: {
    heading: string;
    intro: string;
    highlightBox?: string;
    note?: string;
    footer: string;
  }): string {
    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 28px; background: #ffffff; color: #0f172a; border: 1px solid #e2e8f0; border-radius: 16px;">
        <div style="font-size: 22px; font-weight: 800; color: #2563eb; margin-bottom: 8px;">Chatible</div>
        <h2 style="font-size: 18px; font-weight: 700; margin: 0 0 12px; color: #0f172a;">${escapeHtml(options.heading)}</h2>
        <p style="font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 18px;">${escapeHtml(options.intro)}</p>
        ${options.highlightBox ?? ''}
        ${options.note ? `<p style="font-size: 13px; color: #64748b; line-height: 1.5; margin: 0 0 10px;">${escapeHtml(options.note)}</p>` : ''}
        <p style="font-size: 12px; color: #94a3b8; line-height: 1.5; margin: 0; border-top: 1px solid #e2e8f0; padding-top: 14px;">${escapeHtml(options.footer)}</p>
      </div>
    `;
  }

  private async sendOtpMail(options: {
    email: string;
    code: string;
    subject: string;
    heading: string;
    intro: string;
  }): Promise<{ sent: boolean; reason?: 'disabled' | 'error' }> {
    const cfg = await this.getSmtpConfig();
    if (!cfg.enabled || !cfg.host) {
      return { sent: false, reason: 'disabled' };
    }

    try {
      const safeCode = escapeHtml(options.code);
      const highlightBox = `
        <div style="text-align: center; background: #f1f5f9; border-radius: 12px; padding: 18px; margin-bottom: 20px;">
          <span style="font-family: 'JetBrains Mono', monospace; font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #1d4ed8;">${safeCode}</span>
        </div>
      `;
      await this.sendMail(
        {
          to: options.email,
          subject: options.subject,
          text: `${options.heading}\n\n${options.intro}\nMã xác nhận của bạn là: ${options.code}\nMã có hiệu lực trong vòng 15 phút và chỉ sử dụng 1 lần.`,
          html: this.renderChatibleEmailHtml({
            heading: options.heading,
            intro: options.intro,
            highlightBox,
            note: 'Mã xác nhận này chỉ có hiệu lực trong 15 phút và chỉ được sử dụng 1 lần.',
            footer: 'Lưu ý bảo mật: Tuyệt đối không chia sẻ mã này với bất kỳ ai.',
          }),
        },
        cfg
      );
      return { sent: true };
    } catch (err) {
      console.error('[MailService] Failed to send OTP mail:', err);
      return { sent: false, reason: 'error' };
    }
  }

  async sendPasswordResetOtp(
    email: string,
    code: string
  ): Promise<{ sent: boolean; reason?: 'disabled' | 'error' }> {
    return this.sendOtpMail({
      email,
      code,
      subject: '[Chatible] Mã xác nhận đặt lại mật khẩu của bạn',
      heading: 'Yêu cầu đặt lại mật khẩu',
      intro:
        'Chúng tôi đã nhận được yêu cầu đặt lại mật khẩu cho tài khoản Chatible liên kết với email này. Vui lòng nhập mã xác nhận 6 chữ số bên dưới:',
    });
  }

  async sendEmailVerificationOtp(
    email: string,
    code: string
  ): Promise<{ sent: boolean; reason?: 'disabled' | 'error' }> {
    return this.sendOtpMail({
      email,
      code,
      subject: '[Chatible] Xác minh địa chỉ email của bạn',
      heading: 'Xác minh địa chỉ email',
      intro:
        'Vui lòng nhập mã xác minh 6 chữ số bên dưới trong ứng dụng Chatible để hoàn tất xác minh địa chỉ email tài khoản của bạn:',
    });
  }

  async sendSafetyNotificationEmail(
    email: string,
    subject: string,
    heading: string,
    message: string
  ): Promise<{ sent: boolean; reason?: 'disabled' | 'error' }> {
    const cfg = await this.getSmtpConfig();
    if (!cfg.enabled || !cfg.host) {
      return { sent: false, reason: 'disabled' };
    }
    try {
      await this.sendMail(
        {
          to: email,
          subject,
          text: `${heading}\n\n${message}\n\nVui lòng đăng nhập vào Chatible để xem thông báo chi tiết hoặc gửi khiếu nại nếu cần.`,
          html: this.renderChatibleEmailHtml({
            heading,
            intro: message,
            footer: 'Đây là thông báo an toàn tự động từ Chatible. Không phản hồi trực tiếp email này.',
          }),
        },
        cfg
      );
      return { sent: true };
    } catch (err) {
      console.error('[MailService] Failed to send safety notice email:', err);
      return { sent: false, reason: 'error' };
    }
  }
}
