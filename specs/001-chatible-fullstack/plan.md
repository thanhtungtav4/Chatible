# Kế hoạch Triển khai Chi tiết Dự án Chatible (Fullstack Web ➔ Mobile App)

**Dự án**: Chatible — Nền tảng Chat Ngẫu nhiên 1–1 & Kết bạn Riêng tư  
**Mục tiêu**: Xây dựng phiên bản Web (Mobile-First PWA) trước, chuẩn hóa kiến trúc để kế thừa 100% Backend và 80% logic sang Mobile App (iOS/Android qua Expo/React Native) sau này.  
**Tài liệu tham chiếu**: `docs/dac-ta-nghiep-vu-v1.1.md` và `.specify/memory/constitution.md`  

---

## 1. Technical Context & Stack Decision

| Thành phần | Công nghệ lựa chọn | Lý do & Khả năng tái sử dụng |
|---|---|---|
| **Frontend Web** | **React 19 / Next.js (App Router) + Tailwind CSS + Zustand** | Tái hiện 100% design system Chatx (bo góc pill, dark mode, hiệu ứng radar). Hỗ trợ PWA cài đặt lên màn hình chính điện thoại. |
| **Shared Contracts** | **TypeScript DTOs / Interfaces (`shared/`)** | Dùng chung 100% kiểu dữ liệu, sự kiện WebSocket giữa Backend, Web và App tương lai. |
| **Backend API & Realtime** | **Node.js (NestJS / Fastify + TypeScript) + Socket.io** | Tích hợp sâu WebSocket gateway, hàng đợi matching, kiến trúc module hóa chặt chẽ. |
| **Database Chính** | **PostgreSQL 16** | Quản lý dữ liệu người dùng, hồ sơ, danh sách bạn bè, phiên gần đây, báo cáo vi phạm và audit log. |
| **Cache & Realtime Queue** | **Redis 7** | Hàng chờ ghép đôi (Sorted Sets), pub/sub kết nối đa server, bộ nhớ đệm trạng thái online. |
| **Bảo mật & Mã hóa** | **Envelope Encryption + Local KMS Provider ($0)** | Mỗi tin nhắn/media dùng 1 DEK riêng (AES-256-GCM); DEK được bọc bằng KEK qua Local KMS Provider (Master KEK độc lập ngoài DB qua OS Env / File bí mật). Sẵn sàng nâng cấp Cloud KMS qua interface `IKmsProvider`. Không lưu plaintext hoặc DEK rõ. |
| **Lưu trữ Media** | **Cloudflare R2 / AWS S3** | Lưu trữ ciphertext media; xem qua Presigned URL token mờ hạn ngắn (5 phút). |
| **Mobile App (Sau này)**| **Expo (React Native)** | Kế thừa nguyên vẹn Shared Types, State Store, WebSocket handlers, và kết nối thẳng vào cùng Backend. |

---

## 2. Cấu trúc Dự án (Monorepo Architecture)

```text
Chatible/
├── shared/                       # Hợp đồng dữ liệu dùng chung (Web & Mobile)
│   ├── types/
│   │   ├── auth.ts               # User, Session, 18+ Profile
│   │   ├── matching.ts           # QueueRequest, MatchFilter, MatchingState
│   │   ├── chat.ts               # Message, ChatSession, EnvelopeCiphertext
│   │   ├── media.ts              # MediaUpload, WatermarkConfig, EphemeralToken
│   │   └── camouflage.ts         # StealthModeConfig, VaultState
│   └── constants/
│       └── events.ts             # Danh mục WebSocket Events chuẩn
│
├── backend/                      # Dịch vụ Backend (NestJS / TypeScript)
│   ├── src/
│   │   ├── modules/
│   │   │   ├── auth/             # Email/Pass + Google OAuth, kiểm tra ngày sinh 18+
│   │   │   ├── users/            # Quản lý hồ sơ, bảo vệ thông tin riêng tư (không lộ email/IP)
│   │   │   ├── matching/         # Matching Engine Redis 2 chiều (giới tính + tuổi)
│   │   │   ├── chat/             # Socket Gateway, State Machine (6 trạng thái), Envelope Encryption
│   │   │   ├── media/            # Presigned URL, xác thực magic bytes, Watermark động
│   │   │   ├── friends/          # Quản lý bạn bè, luồng chat offline 30 ngày
│   │   │   ├── reports/          # Đóng băng bằng chứng báo cáo (90 ngày)
│   │   │   └── admin/            # Super Admin duy nhất, AuditLog tự động khi mở nội dung
│   │   ├── common/
│   │   │   ├── kms/              # IKmsProvider & LocalKmsProvider (Master KEK tách biệt ngoài DB, sẵn sàng cho AWS/GCP KMS)
│   │   │   ├── crypto/           # AES-256-GCM Envelope Encryption
│   │   │   └── cron/             # Worker dọn tin: 7 ngày (ngẫu nhiên), 30 ngày (bạn bè)
│   │   └── database/             # Migrations & Seeds
│   └── package.json
│
├── frontend/                     # Web App Client (Mobile-First PWA)
│   ├── src/
│   │   ├── components/           # UI Atoms (Pill Button, Avatar, BottomSheet, Switch)
│   │   ├── features/
│   │   │   ├── chat/             # Khung chat 6 trạng thái (IDLE, WAITING, MATCHING, CHATTING, RECONNECTING, ENDED)
│   │   │   ├── friends/          # Danh sách bạn bè & khung chat 1-1 offline
│   │   │   ├── recent/           # Danh sách 7 ngày & Chế độ ngụy trang Stealth Vault
│   │   │   ├── profile/          # Hồ sơ, Cài đặt ngụy trang, Đổi theme Dark/Light
│   │   │   └── media/            # Nén ảnh WebP client-side, Ghi âm audio, Player
│   │   ├── hooks/                # useSocket, useMatchQueue, useStealthVault
│   │   └── stores/               # Zustand store (quản lý state ứng dụng)
│   └── package.json
│
├── mockup/                       # Bản mẫu HTML/CSS/JS hoàn chỉnh làm chuẩn thiết kế
└── docs/                         # Đặc tả nghiệp vụ v1.1 & Hiến pháp dự án
```

---

## 3. Lộ trình Thực hiện theo Giai đoạn (Phases)

### Giai đoạn 1: Nền tảng Cơ sở & Bảo mật Dữ liệu (Foundation & Security)
- **Thiết lập Dự án**: Khởi tạo cấu trúc thư mục, cấu hình TypeScript monorepo, ESLint, Prettier.
- **Cơ sở Dữ liệu**: Thiết lập PostgreSQL 16 schema với các bảng: `users`, `profiles`, `chat_sessions`, `messages`, `friends`, `friend_requests`, `reports`, `audit_logs`.
- **Mã hóa Envelope với Local KMS Provider ($0)**: Triển khai module Envelope Encryption (AES-256-GCM với DEK riêng biệt cho từng tin nhắn/media; DEK được bọc bằng Master KEK qua Local KMS Provider). KEK được lưu độc lập ngoài Database (qua OS Environment hoặc file bảo vệ `chmod 400`), đảm bảo 100% nếu lộ DB vẫn không thể giải mã nội dung. Thiết kế cắm/rút qua interface `IKmsProvider` để sẵn sàng chuyển sang AWS/GCP KMS khi có kinh phí.
- **Quy tắc Hiến pháp**: Tuyệt đối không lưu trữ hoặc in log plaintext, DEK rõ hoặc KEK.

### Giai đoạn 2: Xác thực 18+ & Realtime Matching Engine
- **Module Auth**:
  - Đăng ký Email/Mật khẩu + Google OAuth.
  - Nhập ngày sinh riêng tư, máy chủ tính tuổi và **chặn ngay nếu dưới 18 tuổi**.
  - Không công khai ngày sinh, email hoặc IP cho đối phương (chỉ hiển thị Biệt danh, Giới tính và Số tuổi).
- **Matching Engine (Redis 2-way Filter)**:
  - Hàng chờ ghép ngẫu nhiên theo thuật toán kiểm tra 2 chiều (A hợp B và B hợp A về giới tính và khoảng tuổi).
  - Tự động gợi ý mở rộng bộ lọc sau 6-10s nếu hàng chờ ít người.
  - Loại trừ đối tác vừa trò chuyện (chống gặp lại liên tiếp).
- **WebSocket Gateway & State Machine**:
  - Quản lý vòng đời chat 6 trạng thái: `IDLE` ➔ `WAITING` ➔ `MATCHING` ➔ `CHATTING` ➔ `RECONNECTING` (đếm ngược 30s) ➔ `ENDED`.

### Giai đoạn 3: Chat Realtime, Pipeline Media & Chế độ Ngụy trang
- **Chat Trực tiếp & Tin nhắn**:
  - Gửi/nhận tin nhắn chữ/emoji thời gian thực, đồng bộ trạng thái đọc/nhận.
  - Thanh hành động kết thúc chat (`ended-action-bar`): Tìm người mới, Kết bạn, Báo cáo (đã tối ưu UI).
- **Pipeline Xử lý Media**:
  - Nén ảnh client-side sang WebP (300KB–800KB) trước khi upload.
  - Ghi âm voice note dạng waveform.
  - Upload an toàn qua S3/R2 Presigned URL mã hóa.
  - Cơ chế đồng ý nhận media: Người lạ phải chủ động bật mới được nhận; gắn Watermark động theo người nhận đối với nội dung 18+.
- **Chế độ Ngụy trang Stealth Vault**:
  - Cài đặt Bật/Tắt và đổi mã PIN bí mật trong mục Cài đặt.
  - Tự động ngụy trang log chat thành màn hình sạch khi mở app.
  - Gõ đúng passcode (mặc định: `8888`) vào ô tìm kiếm ở màn hình Gần đây hoặc Bạn bè để giải mã log chat.
  - Nút Khóa nhanh tích hợp bên trong ô tìm kiếm.

### Giai đoạn 4: Mạng Xã hội Bạn bè, Điều hành & Chuẩn bị App Mobile
- **Tính năng Bạn bè**:
  - Gửi lời mời kết bạn từ phiên chat đang chạy hoặc phiên gần đây.
  - Chấp nhận/từ chối kết bạn, danh bạ bạn bè, trạng thái online/offline.
  - Nhắn tin 1-1 với bạn bè (lưu trữ cuốn chiếu 30 ngày).
- **Phiên Gần đây & Dọn dẹp Tự động (Cron Workers)**:
  - Phiên ngẫu nhiên giữ 7 ngày để xem lại hoặc lấy bằng chứng báo cáo.
  - Worker tự động hủy dữ liệu hết hạn: 7 ngày (chat lạ), 30 ngày (bạn bè).
- **An toàn, Báo cáo & Super Admin**:
  - Báo cáo và chặn: Đóng băng bằng chứng vi phạm, bảo toàn đúng 90 ngày sau khi hồ sơ đóng.
  - Tài khoản Quản trị viên tối cao duy nhất: Toàn quyền phân xử, tự động ghi `AuditLog` cho mỗi lần mở nội dung.
- **Kiểm thử & Tối ưu PWA**:
  - Chạy toàn bộ 103 ca nghiệm thu bắt buộc (T01 – T103).
  - Tinh chỉnh PWA Manifest, Service Worker để cài đặt trực tiếp trên iPhone/Android.
  - Cấu trúc thư mục sẵn sàng để tạo thư mục `app/` (Expo React Native) kế thừa `shared/`.

---

## 4. Danh mục Ca Kiểm thử Trọng yếu (Gates & Verification)

- **Gate 1 (Bảo mật 18+)**: Khai ngày sinh dưới 18 tuổi hoặc ngày tương lai ➔ Từ chối tạo tài khoản.
- **Gate 2 (Cô lập Dữ liệu)**: Bắt gói tin WebSocket/API ➔ Không xuất hiện email, ngày sinh, IP đối tác.
- **Gate 3 (Mã hóa KMS)**: Dữ liệu trong database và object storage đều là ciphertext; giải mã không được DEK nếu không qua KMS.
- **Gate 4 (Ghép đôi 2 chiều)**: Nam chọn Nữ (18-25t) không bao giờ ghép với Nam hoặc người ngoài độ tuổi cho phép nếu chưa bấm mở rộng.
- **Gate 5 (Mất mạng 30s)**: Rớt mạng đột ngột ➔ Đếm ngược 30s ➔ Khôi phục phiên nếu kết nối lại kịp, hoặc kết thúc nếu quá hạn.
- **Gate 6 (Ngụy trang Search Passcode)**: Mở app ➔ Log chat ẩn ➔ Nhập `8888` vào ô tìm kiếm ➔ Log chat hiển thị ngay lập tức.
