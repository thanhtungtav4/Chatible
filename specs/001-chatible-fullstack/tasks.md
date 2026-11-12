---
description: "Danh sách đầu việc chi tiết triển khai Chatible Fullstack"
---

# Tasks: Chatible Fullstack Web ➔ Mobile App Ready

**Đặc tả tham chiếu**: `docs/dac-ta-nghiep-vu-v1.1.md`  
**Hiến pháp**: `.specify/memory/constitution.md`  
**Kế hoạch**: `specs/001-chatible-fullstack/plan.md`  
**Mô hình dữ liệu**: `specs/001-chatible-fullstack/data-model.md`  
**Giao tiếp Contracts**: `specs/001-chatible-fullstack/contracts/api-and-websocket.md`  

---

## Phase 1: Setup & Nền tảng Monorepo (Shared Infrastructure)

- [x] T001 Khởi tạo cấu trúc Monorepo (`shared/`, `backend/`, `frontend/`)
- [x] T002 Cấu hình TypeScript DTOs và Interfaces trong `shared/types/` dùng chung cho Web và Mobile
- [x] T003 Thiết lập Docker Compose môi trường cục bộ: PostgreSQL 16 + Redis 7 + MinIO (S3 mock)
- [x] T004 Khởi tạo project Backend (NestJS / Fastify + TypeScript) với Drizzle ORM (siêu nhẹ, zero-overhead, type-safe)
- [x] T005 [P] Khởi tạo project Frontend (React 19 / Next.js App Router + Tailwind CSS + Lucide Icons)
- [x] T006 Cấu hình ESLint, Prettier và quy tắc không in log plaintext/token theo `constitution.md`

---

## Phase 2: Cơ sở Dữ liệu & Module Mã hóa Envelope KMS (Foundational)

- [x] T007 Xây dựng Migration PostgreSQL: bảng `users`, `profiles`, `chat_sessions`, `messages`
- [x] T008 [P] Xây dựng Migration PostgreSQL: bảng `friends`, `friend_requests`, `reports`, `audit_logs`
- [x] T009 Triển khai Module Local KMS Provider với Interface `IKmsProvider` (Master KEK độc lập qua OS Env/File bí mật, bọc/mở DEK bằng AES-KeyWrap, sẵn sàng cắm Cloud KMS)
- [x] T010 Triển khai Module Crypto Envelope (AES-256-GCM sinh DEK riêng biệt cho từng đối tượng)
- [x] T011 [Test] Viết unit test mã hóa/giải mã Envelope: Dữ liệu DB chỉ là ciphertext, không có DEK rõ

---

## Phase 3: Module Auth 18+ & User Profile (Story 1 - Priority: P1)

- [x] T012 Triển khai API Đăng ký `POST /api/v1/auth/register` với kiểm tra ngày sinh >= 18 tuổi (T01, T02)
- [x] T013 Triển khai Google OAuth login `POST /api/v1/auth/google` và thu thập ngày sinh bắt buộc (D02)
- [x] T014 Triển khai API Đăng nhập `POST /api/v1/auth/login` cấp JWT token
- [x] T015 Triển khai Module Profile: Khởi tạo Giới tính, Biệt danh, Tiêu chí tìm kiếm (Nam/Nữ/Khác, 18-30t)
- [x] T016 [P] Frontend Auth UI: Màn hình Đăng ký, Đăng nhập, Khởi tạo hồ sơ chọn giới tính lần đầu
- [x] T017 [Security Test] Kiểm tra API: Chặn ngay nếu khai ngày sinh < 18 tuổi hoặc ngày tương lai

---

## Phase 4: Matching Engine & Realtime Gateway 6 Trạng thái (Story 2 - Priority: P1)

- [x] T018 Xây dựng Redis Matching Queue (ZSET) với Lua Script ghép đôi 2 chiều nguyên tử
- [x] T019 Triển khai Logic mở rộng bộ lọc sau 6-10s chờ nếu hàng chờ ít người (D11)
- [x] T020 Triển khai Cơ chế chống gặp lại đối tác vừa trò chuyện (avoid repeat match)
- [x] T021 Xây dựng WebSocket Gateway (Socket.io) quản lý 6 trạng thái:
      `IDLE` ➔ `WAITING` ➔ `MATCHING` ➔ `CHATTING` ➔ `RECONNECTING` ➔ `ENDED`
- [x] T022 Triển khai đếm ngược mất mạng 30s (`RECONNECTING`) và tự động phục hồi khi có mạng lại
- [x] T023 [P] Frontend Chat Engine: Tích hợp hiệu ứng Radar Sonar khi chờ, đếm ngược thời gian thực
- [x] T024 [P] Frontend Chat Bar: Tích hợp thanh hành động kết thúc `ended-action-bar` đã tối ưu

---

## Phase 5: Pipeline Media & Nội dung 18+ Bảo mật (Story 3 - Priority: P2)

- [x] T025 Client-side Image Compressor: Tự động nén ảnh sang WebP (300KB-800KB) trước khi gửi
- [x] T026 Voice Audio Recorder: Ghi âm chuẩn Opus/AAC và tính toán mảng 30 điểm biên độ sóng âm
- [x] T027 API Presigned URL `POST /api/v1/media/presign-upload` upload ciphertext trực tiếp lên S3/R2
- [x] T028 Cơ chế đồng ý nhận Media: Người lạ phải chủ động bật quyền mới được gửi ảnh/video
- [x] T029 Watermark động theo người nhận (Recipient Trace Token) cho ảnh/video 18+
- [x] T030 API Token xem hạn ngắn 5 phút `GET /api/v1/media/:id/view-token` (không có link tải cố định)
- [x] T031 Tính năng người gửi chủ động thu hồi quyền xem media đã gửi (REVOKE)

---

## Phase 6: Bạn bè, Chat Offline & Chế độ Ngụy trang Stealth Vault (Story 4 - Priority: P2)

- [x] T032 Tính năng Gửi/Nhận lời mời kết bạn từ phiên chat đang chạy hoặc phiên gần đây (FRI-01)
- [x] T033 Khung chat bạn bè 1-1: Nhắn tin khi đối phương offline, tự động xóa cuốn chiếu sau 30 ngày
- [x] T034 Màn hình Phiên gần đây (Lưu 7 ngày xem lại) với thẻ `recent-card` đã tối ưu (không tràn chữ)
- [x] T035 Tích hợp Chế độ Ngụy trang Stealth Vault:
      - Tự động ngụy trang log chat khi mở app
      - Nhập passcode (`8888`) vào ô tìm kiếm để mở khóa
      - Nút Khóa tích hợp bên trong ô tìm kiếm
- [x] T036 Cron dọn dẹp dữ liệu: Xóa phiên random quá 7 ngày, tin bạn bè quá 30 ngày, và object media hết hạn/đã thu hồi trước khi xóa metadata

---

## Phase 7: Báo cáo, Đóng băng Bằng chứng & Super Admin AuditLog (Story 5 - Priority: P3)

- [x] T037 Tính năng Chặn 2 chiều tức thì (BLOCK-02): Dừng chuyển tin, hủy quan hệ bạn bè nếu có
- [x] T038 Tính năng Báo cáo vi phạm: Bảo toàn bằng chứng (DEK + Ciphertext) trong suốt thời gian xử lý và 90 ngày sau khi đóng
- [x] T039 Tài khoản Quản trị viên Tối cao duy nhất (Super Admin) toàn quyền xem nội dung phân xử
- [x] T040 Tự động ghi nhật ký `AuditLog` (Actor, Thời gian, Session ID) mỗi khi Super Admin mở xem nội dung
- [x] T041 Cấm tuyệt đối Super Admin hay hệ thống đọc lén tin nhắn ngoài luồng phân xử báo cáo

---

## Phase 8: Nghiệm thu 103 Ca Test & Tối ưu Sẵn sàng cho Mobile App

- [x] T042 Kiểm thử tự động toàn bộ 103 ca nghiệm thu (T01 – T103) trong `docs/dac-ta-nghiep-vu-v1.1.md`
- [x] T043 Cấu hình Web App Manifest, Service Worker và Responsive Safe Area cho trải nghiệm PWA mượt mà
- [x] T044 Đóng gói module `shared/` thành npm workspace package độc lập
- [x] T045 Tài liệu hóa hướng dẫn khởi tạo dự án Mobile App Expo (React Native) kết nối thẳng vào Backend
