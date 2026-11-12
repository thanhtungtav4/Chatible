# Chatible — Nền Tảng Chat Ngẫu Nhiên 1-1 & Mạng Xã Hội Riêng Tư (Mobile-First)

Mã nguồn chính thức: [github.com/thanhtungtav4/Chatible](https://github.com/thanhtungtav4/Chatible)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.2-black.svg)](https://fastify.dev/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4.8-white.svg)](https://socket.io/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-3.4-38bdf8.svg)](https://tailwindcss.com/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-0.38-green.svg)](https://orm.drizzle.team/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791.svg)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-dc382d.svg)](https://redis.io/)
[![Tests](https://img.shields.io/badge/Tests-67%2F67%20Pass-brightgreen.svg)]()

**Chatible** là giải pháp phần mềm hoàn chỉnh cho nền tảng kết nối ngẫu nhiên 1-1 ẩn danh, trò chuyện đa phương tiện an toàn và kết nối bạn bè riêng tư. Hệ thống được kiến trúc theo chuẩn **Monorepo** với thiết kế **Mobile-First PWA**, sẵn sàng mở rộng và đóng gói lên App Store / Google Play thông qua React Native (Expo).

---

## 🚀 Tính Năng Cốt Lõi (Core Features)

### 1. Hàng Chờ Ghép Đôi 2 Chiều Nguyên Tử (Atomic 2-Way Matching)
- **Thuật toán ghép đôi FIFO 2 chiều**: Chỉ ghép khi cả 2 người dùng thỏa mãn đồng thời tiêu chí của nhau (Giới tính: *Tất cả*, *Nữ*, *Nam*, *Khác*; Khoảng tuổi: *18 – 50+*).
- **Tránh trùng lặp (`lastPartnerId`)**: Tự động chặn ghép đôi lại với đối phương vừa trò chuyện gần nhất.
- **Tự động mở rộng bộ lọc**: Khi hàng chờ vắng, gợi ý mở rộng phạm vi tuổi/giới tính sau 6–10 giây.
- **Phối hợp đa node (Multi-instance Redis Coordinator)**: Đồng bộ phiên qua Redis Pub/Sub và Adapter, cam kết không xảy ra race-condition (1 người dùng không bao giờ bị ghép đôi 2 lần cùng lúc).

### 2. Mật Mã Học, Cookie-Only Auth & An Toàn Dữ Liệu (Envelope Encryption & Cloud KMS)
- **Mã hóa phong bì (Envelope Encryption)**: Mỗi tin nhắn và media được sinh khóa dữ liệu riêng (DEK) mã hóa `AES-256-GCM`; đây là cơ chế mã hóa quản lý khóa phía hệ thống (không phải E2EE) để vừa bảo vệ lưu trữ vừa phục vụ trích xuất bằng chứng khi có báo cáo hợp lệ.
- **Cloud KMS & Khóa Production Bắt Buộc**: Ở `NODE_ENV=production`, hệ thống fail-fast nếu thiếu `ADMIN_TOTP_SECRET` (Base32 >= 16 ký tự), customer-managed AWS KMS (`KMS_PROVIDER=aws-kms`), hoặc S3 HTTPS (`https://`).
- **Xác thực Cookie-Only `HttpOnly` & Chống CSRF/XSS**: JWT phiên người dùng, Stealth Vault và Super Admin hoàn toàn không trả token thô về JavaScript/JSON và từ chối Bearer header trên web APIs lẫn Socket.IO; tất cả yêu cầu thay đổi trạng thái bắt buộc double-submit `X-CSRF-Token` kết hợp kiểm `Origin`, `@fastify/helmet` CSP, thu hồi JWT theo `jti` và Redis sliding-window rate limiter (`DistributedRateLimiter`).

### 3. Pipeline Media, Worker Video Độc Lập, 18+ Consent & Watermark
- **Kiểm tra Streaming Upload (< 1 MB RAM)**: Sau khi PUT lên S3, `/complete` kiểm tra kích thước thực, giải mã streaming xác thực GCM tag + magic bytes ngay trên luồng để loại bỏ tệp giả mạo mà không buffer 100 MB vào RAM API. Chat Gateway chỉ chấp nhận tin media gắn `mediaId` ở trạng thái `READY`.
- **Worker Video Độc Lập & Cache Theo Người Nhận**: Tác vụ đốt watermark video (`ffmpeg -threads 1`) được tách khỏi process API sang `media-worker.process.ts` (`--max-old-space-size=512`), giới hạn đồng thời toàn cụm bằng Redis Lua semaphore (`maxConcurrency = 1`), xử lý qua đĩa tạm và cache bản đã watermark vào bảng `media_watermarked_variants`. Trong lúc xử lý, API trả HTTP `202 Accepted` để client tự poll.
- **Cổng Đồng Ý Media & 18+ + Giới Hạn Công Nghệ Trung Thực**: Người nhận phải bật quyền nhận media thông thường và xác nhận riêng (`ADULT-11`) cho nội dung 18+; người gửi xác nhận 2 cam kết pháp lý (`ADULT-04`). Ảnh (`sharp`) và video (`ffmpeg`) đều nhúng watermark truy vết theo người nhận và tắt nút tải trực tiếp — nhưng nền tảng luôn công bố trung thực rằng watermark chỉ phục vụ răn đe/truy vết và không thể ngăn thiết bị ngoài chụp hoặc quay lại màn hình.

### 4. Bạn Bè 1-1, Nhóm Cộng Đồng Có Kiểm Duyệt & Stealth Vault
- **Nhắn tin Bạn bè 1-1 (TEXT & Media)**: Kết bạn từ phiên ngẫu nhiên, hỗ trợ gửi chữ, ảnh, audio, video và chế độ 18+ (lưu trữ 30 ngày, cron tự dọn phiên hết hạn).
- **Nhóm & Kênh (`BROADCAST`, `PUBLIC`, `PRIVATE_PASSCODE`) Có An Toàn**: Hỗ trợ báo cáo tin nhắn nhóm (`POST /api/v1/groups/:roomId/messages/:messageId/report`), chặn tác giả tin nhắn (`.../block`, tự ẩn tin ở tầng service & Socket.IO mà không lộ `senderId` thô), và Super Admin gỡ tin vi phạm (`DELETE_GROUP_MESSAGE` có AuditLog).
- **Stealth Vault Bảo Vệ Backend & Reload**: Khi bật PIN 4 số, API lịch sử trả `423 Locked` nếu thiếu cookie `HttpOnly SameSite=Strict`; `GET /api/v1/users/me/stealth-vault` trả trạng thái `unlocked` từ cookie để reload trang giữ đúng trạng thái mở khóa.

### 5. An Toàn, Báo Cáo Vi Phạm, Super Admin Deck & Vận Hành Go-Live
- **Bắt buộc 18+**: Chặn đăng ký ngay lập tức nếu ngày sinh tính đến thời điểm hiện tại dưới 18 tuổi.
- **Đóng băng bằng chứng 90 ngày**: Báo cáo ở cả Chat 1-1 lẫn Nhóm cộng đồng bảo lưu bằng chứng nguyên vẹn trong 90 ngày, kể cả khi phiên chat hết hạn sau 7 ngày.
- **Super Admin Control Deck (`/admin`) Bảo Vệ CSRF & Bắt Buộc TOTP 2FA**:
  - Xác thực Super Admin qua cookie `HttpOnly SameSite=Strict` + header `X-CSRF-Token`, bắt buộc TOTP 2FA và vô hiệu hóa hoàn toàn nút/API tắt 2FA (`403`).
  - Quản lý cấu hình Google Auth, Mail SMTP (mật khẩu bọc KMS AES-256-GCM), chu kỳ lưu trữ, adjudicate bằng chứng & gỡ tin nhóm, duyệt đơn khiếu nại và xem chuỗi `audit_logs` nối SHA-256.
- **Khuyến Nghị Hạ Tầng Go-Live**: Role DB cho ứng dụng/ORM không phải PostgreSQL superuser/owner của `audit_logs` (chỉ `SELECT, INSERT` để bảo toàn trigger append-only), cấu hình S3 Object Lock (WORM) sao lưu audit log ngoài DB và chạy tiến trình `worker:media` độc lập.

> **Lưu ý vận hành media:** Ở production, chạy worker watermark video như một service/container độc lập có restart policy, readiness/heartbeat và FFmpeg. Không chỉ dựa vào process API; khi worker không healthy, API phải báo không sẵn sàng thay vì để video chờ vô hạn.

### 6. Khôi Phục Tài Khoản & Chế Độ Ngụy Trang (Stealth Vault)
- **Quên và đặt lại mật khẩu**: Sinh mã OTP ngẫu nhiên 6 chữ số (hết hạn 15 phút, chống brute-force và email enumeration).
- **Đổi mật khẩu & Tự xóa tài khoản**: Hỗ trợ đổi mật khẩu xác thực mật khẩu cũ và tự xóa tài khoản vĩnh viễn (`DELETE /api/v1/users/me`).
- **Chế độ ngụy trang (Stealth Vault)**: Bảo vệ lịch sử phiên trò chuyện gần đây bằng mã PIN 4 chữ số, ngụy trang dưới dạng ứng dụng ghi chú cá nhân vô hại.

---

## 🏗️ Kiến Trúc Hệ Thống (Architecture)

```
chatible/
├── shared/            # Thư viện dùng chung TypeScript (Contracts, DTOs, Enums, SocketEvents)
├── backend/           # Máy chủ Fastify, Socket.IO Gateway, Drizzle ORM, KMS adapter
│   ├── src/
│   │   ├── admin/     # Super Admin Control Deck, TOTP MFA, giải mã media & chuỗi Audit SHA-256
│   │   ├── auth/      # Đăng ký 18+, Cookie HttpOnly/CSRF, Stealth Vault 423, Redis rate limiter
│   │   ├── config/    # Cấu hình môi trường, bắt buộc HTTPS S3 & Cloud KMS ở Production
│   │   ├── cron/      # DataCleanupService tự động dọn phiên RANDOM/FRIEND/Group/Media hết hạn
│   │   ├── crypto/    # EnvelopeCryptoService (AES-256-GCM)
│   │   ├── database/  # Drizzle schema (PostgreSQL + trigger append-only audit_logs)
│   │   ├── friends/   # Kết bạn 2 chiều & Chat bạn bè 1-1 (TEXT, IMAGE, AUDIO, VIDEO, 18+)
│   │   ├── groups/    # Kênh Broadcast, Nhóm Public & Nhóm Private Passcode
│   │   ├── kms/       # AwsKmsService (@aws-sdk/client-kms) & LocalKmsService (Dev)
│   │   ├── mail/      # MailService gửi email SMTP động & template OTP
│   │   ├── matching/  # MatchingEngine 2 chiều & Redis Session Coordinator
│   │   ├── media/     # Upload finalize/magic-bytes, 18+ consent, watermark sharp/ffmpeg
│   │   ├── realtime/  # ChatGateway Socket.IO xác thực media READY & clientMessageId
│   │   ├── safety/    # Báo cáo, Đóng băng bằng chứng 90 ngày & Appeals
│   │   └── sessions/  # Quản lý phiên gần đây (7 ngày, khóa 423 Stealth Vault)
├── frontend/          # Ứng dụng Web PWA (React 19, Vite, Tailwind CSS, Lucide)
│   ├── src/
│   │   ├── features/chat/       # ChatEngine 6 trạng thái, Media & công tắc/xác nhận 18+
│   │   ├── features/friends/    # FriendsView 1-1 hỗ trợ Text, Media, Audio & 18+
│   │   ├── features/groups/     # GroupsView cho Broadcast/Public/Private Passcode
│   │   ├── features/media/      # Encrypted upload/finalize/view/revoke client
│   │   ├── features/sessions/   # RecentSessionsView & Stealth Vault PIN
│   │   ├── features/profile/    # ProfileView, chính sách minh bạch & Stealth PIN
│   │   └── features/safety/     # ReportModal phân loại 6 danh mục vi phạm
├── mockup/            # Bản mẫu giao diện trực quan HTML5/CSS3 mô phỏng iPhone 16 Pro
└── docs/              # Đặc tả nghiệp vụ v1.1 & Hướng dẫn tích hợp Mobile App Expo
```

---

## 🛠️ Hướng Dẫn Cài Đặt & Vận Hành (Getting Started)

### 1. Yêu cầu môi trường (Prerequisites)
- **Node.js**: >= 20.0.0
- **Bun**: >= 1.1.0 (dùng để chạy bộ test tự động siêu tốc)
- **PostgreSQL**: >= 16.0
- **Redis**: >= 7.0

*(Hoặc khởi chạy nhanh cơ sở dữ liệu qua Docker Compose)*:
```bash
docker compose up -d
```

### 2. Cài đặt thư viện dependencies
```bash
npm install
```

### 3. Cấu hình biến môi trường
Sao chép mẫu cấu hình môi trường:
```bash
cp .env.example .env
```
Cập nhật các tham số bảo mật chính trong file `.env`:
- `DATABASE_URL`: Đường dẫn kết nối PostgreSQL (ví dụ: `postgresql://user:password@localhost:5432/chatible_db`).
- `REDIS_URL`: Đường dẫn Redis (ví dụ: `redis://localhost:6379`).
- `JWT_SECRET`: Khóa ký JWT người dùng (tối thiểu 32 ký tự).
- `ADMIN_JWT_SECRET`: Khóa ký JWT riêng biệt cho Quản trị viên (tối thiểu 32 ký tự).
- `APP_MASTER_KEK`: Khóa Master KEK 256-bit gồm đúng 64 ký tự hex.
- `CORS_ORIGIN`: Danh sách URL client được phép kết nối (ví dụ: `http://localhost:5173`).

### 4. Chạy Migration Cơ sở dữ liệu
```bash
npm run db:migrate
```

### 5. Khởi chạy môi trường phát triển (Development)
- **Khởi chạy Backend (Port 3000)**:
  ```bash
  npm run dev:backend
  ```
- **Khởi chạy Frontend Web Client (Port 5173)**:
  ```bash
  npm run dev:frontend
  ```

---

## 🧪 Kiểm Thử & Kiểm Định Chất Lượng (Testing & QA)

Dự án tích hợp 16 file kiểm thử tự động với 67 ca test (517 assertions), bao gồm kiểm thử trình duyệt Chrome thật (CDP) và FFmpeg video worker:

```bash
# Chạy toàn bộ 67 ca kiểm thử tự động
npm test

# Kiểm tra tĩnh kiểu dữ liệu (TypeScript Typecheck) trên toàn bộ Monorepo
npm run typecheck

# Kiểm tra quy chuẩn mã nguồn (ESLint không cảnh báo)
npm run lint

# Đóng gói sản phẩm Production (Shared, Backend và Frontend)
npm run build
```

### Bảng tóm tắt kết quả kiểm thử (67/67 PASS):
- ✅ **Matching Queue (`matching.spec.ts`, 7/7)**: Ghép đôi 2 chiều, chống lặp đối tác, mở rộng bộ lọc sau 6s, đồng bộ Redis đa node.
- ✅ **Cloud KMS & Prod Config (`cloud-kms.spec.ts`, 2/2)**: AWS KMS wrap/unwrap + key-access audit hooks; production fail-fast thiếu Cloud KMS, S3 HTTPS hoặc `ADMIN_TOTP_SECRET`.
- ✅ **Envelope Encryption (`envelope.spec.ts`, 3/3)**: Mã hóa DEK AES-256-GCM và kiểm toàn vẹn AuthTag.
- ✅ **Auth, Cookie-Only, CSRF & Stealth 423 (`auth.spec.ts` + `session-security.spec.ts`, 17/17)**: Chính sách 18+, Google OAuth, Quên/Đổi MK, Xóa tài khoản, Cookie-only `HttpOnly` (từ chối Bearer trên web/trả JSON không token), CSRF/Origin tách biệt user/admin, Stealth Vault 423 + `unlocked` khi reload, logout JTI revocation và Redis rate limiter.
- ✅ **SMTP Mail Delivery (`mail.spec.ts`, 2/2)**: Mã hóa KMS mật khẩu SMTP tại DB, che giấu mật khẩu trên API, gửi mail thử nghiệm và OTP Quên mật khẩu.
- ✅ **Admin Control Deck, CSRF & Chrome E2E (`admin.controller.spec.ts` + `admin-hardening.spec.ts`, 6/6)**: Admin TOTP MFA bắt buộc, chặn tắt MFA `403`, cookie 15p `HttpOnly Strict` + `chatible_admin_csrf` độc lập, giải mã media có audit, gỡ tin nhóm, trigger SQL append-only chuỗi SHA-256 `audit_logs`, và test E2E trên Chrome thật (`login ➔ mở bằng chứng ➔ xử lý report`).
- ✅ **Media Bounds, Sharp Semaphore, Cache & Video Worker (`media.spec.ts` + `media-worker.spec.ts`, 12/12)**: Streaming GCM + magic-byte check, chặn ảnh >`4096×4096`/`16.7MP`, SharpProcessingSemaphore `503`, cache biến thể ảnh/video `media_watermarked_variants`, heartbeat worker & FFmpeg readiness check (`503` khi worker chết), và FFmpeg worker tách process (`202` polling, Redis Lua semaphore `maxConcurrency=1`).
- ✅ **Safety & Appeals (`safety.spec.ts`, 4/4)**: Báo cáo vi phạm, đóng băng bằng chứng 90 ngày, chặn/bỏ chặn 2 chiều, khiếu nại.
- ✅ **Groups & Safety Moderation (`groups.spec.ts`, 1/1)**: `BROADCAST` chỉ Admin đăng bài, `PUBLIC`, `PRIVATE_PASSCODE`, báo cáo/chặn tác giả trong Nhóm và Admin gỡ tin vi phạm.
- ✅ **Session Lifecycle & Gateway (`recent-sessions.controller.spec.ts` + `chat.gateway.spec.ts`, 4/4)**: Handshake Socket.IO cookie-only (từ chối `auth.token`), reconnect 30s, `clientMessageId` chống trùng lặp, chặn tin media giả, `emitGroupMessage` fail-closed khi Redis/DB lỗi + retry an toàn, lịch sử 7 ngày.
- ✅ **Friends 1-1 Text & Media (`friends.spec.ts`, 5/5)**: Kết bạn, cooldown 7 ngày, chat offline 30 ngày, ảnh & 18+ giữa bạn bè.
- ✅ **Data Retention & Cleanup (`cleanup.spec.ts`, 4/4)**: Dọn phiên ngẫu nhiên 7 ngày, phiên bạn bè 30 ngày, tin nhóm hết hạn, báo cáo 90 ngày và xóa storage an toàn.

---

## 📱 Sẵn Sàng Đóng Gói Mobile App

Dự án đã chuẩn bị sẵn tài liệu kiến trúc và hướng dẫn kết nối trực tiếp vào React Native (Expo) tại:
👉 [`docs/mobile-app-integration-guide.md`](file:///Volumes/Manager%20Data/Chatible/docs/mobile-app-integration-guide.md)

---

## 📄 Bản Quyền & Giấy Phép
Dự án được phát triển theo tiêu chuẩn kỹ thuật chuyên nghiệp, an toàn thông tin và bảo mật dữ liệu riêng tư.
