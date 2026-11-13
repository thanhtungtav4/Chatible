# Tiến Độ Triển Khai Kỹ Thuật & Đánh Giá Sản Phẩm (Product & Technical Status Dashboard)

**Dự án**: Chatible — Nền tảng Chat Ẩn Danh 1-1 An Toàn (Web ➔ Mobile App Ready)  
**Cập nhật lần cuối**: 2026-11-12  
**Mức độ sẵn sàng**: 🟢 **CODE COMPLETE & SECURITY HARDENED (70/70 TESTS PASS) — SẴN SÀNG CHO THỬ NGHIỆM KÍN (PRE-BETA PILOT)**  

---

## 📊 Ma Trận Đánh Giá Trưởng Thành Sản Phẩm (Maturity Matrix)

Thay vì đánh đồng "có code" là "xong", hệ thống Chatible được đo lường qua 3 cấp độ nghiệm thu nghiêm ngặt theo khuyến nghị của PM:

| Hạng mục chức năng | Cấp độ 1: Đã có Code | Cấp độ 2: Đã qua CI Test | Cấp độ 3: Nghiệm thu Pre-Beta | Ghi chú vận hành / Bảo mật |
|---|:---:|:---:|:---:|---|
| **1. Xác thực & Khôi phục tài khoản** | ✅ | ✅ | 🟡 Sẵn sàng thử nghiệm | Cookie-only web auth (`HttpOnly` JWT, không trả `accessToken`/`vaultToken` ra JS, từ chối Bearer trên web routes/Socket.IO), Xác minh email 6 số (tuỳ chọn ép xác minh trước khi ghép đôi qua cài đặt Admin), Quên/Đặt lại MK 6 số, Đăng nhập Google (tự xác minh) + 18+, Tự xóa tài khoản. |
| **2. Minh bạch Riêng tư & Điều khoản** | ✅ | ✅ | 🟢 Đạt chuẩn | Sửa copy "Tự khai 18+", công khai mô hình mã hóa KMS hệ thống giữ khóa, hạn lưu 7/30/90 ngày, minh định watermark chỉ nhằm răn đe/truy vết và không thể chống chụp/quay màn hình. |
| **3. Ghép đôi 2 chiều & WebSocket Gateway** | ✅ | ✅ | 🟡 Sẵn sàng thử nghiệm | Matching 2 chiều nguyên tử qua Redis, bỏ số đếm ảo, xử lý reconnect 30s, handshake bắt buộc cookie `HttpOnly`, lọc tin nhóm fail-closed (không fallback broadcast khi lỗi Redis/DB, ghi metric & retry an toàn). |
| **4. Pipeline Media, Worker Video & 18+** | ✅ | ✅ | 🟢 Đạt chuẩn | Ảnh giới hạn `4096×4096` (~16.77 MP), Sharp chạy qua temp disk + semaphore (`SHARP_CONCURRENCY=1`, backpressure `503`) + cache `media_watermarked_variants` theo người nhận; Video qua `media-worker` tách riêng có heartbeat Redis, `/health` & `/ready` + API trả `503` khi worker/FFmpeg lỗi. |
| **5. Bạn bè & Lịch sử phiên gần đây** | ✅ | ✅ | 🟢 Đạt chuẩn | Kết bạn từ phiên ngẫu nhiên, chat offline 30 ngày hỗ trợ cả TEXT & media (`IMAGE`/`AUDIO`/`VIDEO`/18+), cooldown hủy/từ chối 7 ngày, cron dọn cả phiên `FRIEND` hết hạn. |
| **6. Chế độ Ngụy trang (Stealth Vault)** | ✅ | ✅ | 🟢 Đạt chuẩn | PIN 4 số băm trên máy chủ, backend trả `423 Locked` nếu thiếu cookie `chatible_vault_unlock` `HttpOnly Strict`, API cấu hình trả trạng thái `unlocked` chuẩn xác sau reload trang. |
| **7. An toàn, Báo cáo, Admin & Kiểm toán** | ✅ | ✅ | 🟢 Đạt chuẩn | Phân luồng `URGENT`/`HIGH`/`MEDIUM`, chuyển trạng thái `OPEN` ➔ `IN_REVIEW` ➔ `RESOLVED`, hộp thư thông báo an toàn (+ email không chặn) bảo mật danh tính người tố cáo, Admin cookie `HttpOnly Strict` + `X-CSRF-Token`, bắt buộc TOTP MFA, báo cáo/chặn/gỡ tin Nhóm có AuditLog, test E2E Chrome thật. |
| **8. Vận hành, Cloud KMS & Hạ tầng Go-Live** | ✅ | ✅ | 🟢 Đạt chuẩn | Bắt buộc Cloud KMS (`@aws-sdk/client-kms`) + S3 HTTPS + `ADMIN_TOTP_SECRET` Base32 ở production, Distributed Redis Rate Limiter, Kênh/Nhóm có kiểm duyệt, cronjob 7/30/90 ngày. |

*Chú giải*:  
- ✅ **Đã hoàn thành & xác thực tự động**: Toàn bộ mã nguồn, types, migrations và test tích hợp đã pass.  
- 🟡 **Sẵn sàng thử nghiệm (Pre-Beta Pilot)**: Sẵn sàng đưa vào nhóm người dùng thử nghiệm kín để thu thập số liệu hành vi thực tế trước khi mở rộng quy mô.  

---

## 🎯 Chi Tiết Nâng Cấp Sau Đánh Giá PM (PM Review Implementations)

### 1. Tài khoản & Khả năng quay lại (Account & Retention)
- **Xác minh email (Email Verification)**:
  - Bảng `email_verification_tokens` lưu mã OTP 6 chữ số băm SHA-256 (hết hạn 15 phút, dùng 1 lần, cooldown gửi lại 60 giây, lỗi SMTP không làm gãy đăng ký).
  - Đăng nhập Google tự động đánh dấu `emailVerifiedAt`; cấu hình Admin `auth.email_verification.required` (mặc định `'false'`, bật trên `/admin` để chặn người dùng chưa xác minh khỏi hàng chờ ghép đôi `MATCHING_JOIN` / `MATCHING_EXPAND_ACCEPT`).
  - Hỗ trợ nhập OTP trực tiếp sau đăng ký (`VERIFY_EMAIL` trong `AuthModal`) hoặc xác minh bổ sung trong Hồ sơ (`ProfileView`).
- **Quên và đặt lại mật khẩu**:
  - Bảng `password_reset_tokens` lưu mã ngẫu nhiên 6 chữ số có băm bảo mật SHA-256.
  - Hết hạn sau 15 phút, giới hạn 1 lần sử dụng, cooldown gửi lại mã 60 giây trên UI.
  - Chống tấn công dò tài khoản (Email Enumeration): API trả về thông điệp trung tính kể cả khi email chưa từng đăng ký.
- **Đăng nhập Google trên UI**:
  - Tích hợp nút Đăng nhập Google chuẩn thương hiệu.
  - Luồng onboarding `GOOGLE_ONBOARD` bắt buộc người dùng mới xác nhận ngày sinh đủ 18 tuổi và đồng ý với điều khoản sử dụng.
- **Tự xóa tài khoản (Self-Service Account Deletion)**:
  - Endpoint `DELETE /api/v1/users/me` cho phép người dùng tự xóa tài khoản.
  - Ẩn danh hóa hồ sơ (`status = 'DELETED'`, tên đổi thành *"Người dùng đã xóa"*), hủy toàn bộ quan hệ bạn bè.
  - **Bảo toàn bằng chứng báo cáo**: Nếu người dùng đang bị báo cáo vi phạm, bản ghi bằng chứng đã đóng băng vẫn được lưu đủ 90 ngày theo luật an toàn số nhằm bảo vệ nạn nhân.

### 2. Thông tin riêng tư đúng với thực tế (Realistic Privacy & Disclosure)
- **Sửa nhãn xác thực tuổi**: Thay đổi từ *"Tài khoản đã xác minh 18+"* thành *"Tự khai 18+ (Dựa trên ngày sinh, chưa xác thực CCCD/hộ chiếu)"*.
- **Bảng công bố quyền riêng tư minh bạch trong Hồ sơ**:
  - Dữ liệu hiển thị cho đối phương: Biệt danh, giới tính tự khai, độ tuổi tính theo năm sinh.
  - Cơ chế mã hóa: Mã hóa phong bì (Envelope Encryption AES-256-GCM) do hệ thống quản lý Master Key ($0 local KMS / Cloud KMS).
  - Chu kỳ lưu trữ: Tin chat ngẫu nhiên 7 ngày, tin nhắn bạn bè 30 ngày, hồ sơ báo cáo vi phạm 90 ngày.
  - Giới hạn công nghệ: Nền tảng áp dụng watermark, link ký tạm thời và hủy token để giảm thiểu rủi ro, nhưng không thể ngăn chặn tuyệt đối việc chụp màn hình từ thiết bị ngoại vi hoặc máy ảnh vật lý.

### 3. Quy trình Xử lý Báo cáo & Khiếu nại toàn diện (Safety & Moderation Workflow)
- **Phân loại mức độ khẩn cấp tự động**:
  - `URGENT`: Khiêu dâm trẻ em / Dưới 18 tuổi (`UNDERAGE`), Đe dọa bạo lực (`THREAT`).
  - `HIGH`: Phát tán ảnh nhạy cảm không đồng thuận (`NONCONSENSUAL_MEDIA`), Quấy rối nghiêm trọng (`HARASSMENT`).
  - `MEDIUM`: Spam, hành vi làm phiền khác (`SPAM`, `OTHER`).
- **Kết luận xử lý rõ ràng của Quản trị viên**:
  - Bổ sung `resolution_conclusion` (`ACTION_TAKEN`, `DISMISSED`, `NO_VIOLATION`), `admin_note` và lưu vết `resolved_by`.
  - Quyết định xử lý có thể kích hoạt hạn chế tài khoản (`bannedUntil`, `isRestricted`).
- **Chuyển trạng thái `IN_REVIEW` & Hộp thư Thông báo An toàn (Safety Notifications)**:
  - Quản trị viên có thể tiếp nhận hồ sơ từ `OPEN` sang `IN_REVIEW` qua `POST /api/v1/admin/reports/:id/review` (kiểm tra lạc quan + ghi `AuditLog`).
  - Bảng `user_notifications` cùng API `GET /api/v1/notifications` & `POST /api/v1/notifications/read` (mở cho cả tài khoản `ACTIVE` và `RESTRICTED`) gửi thông báo kết quả xử lý báo cáo (`REPORT_RESOLVED`), thông báo hạn chế tài khoản (`ACCOUNT_RESTRICTED`, **tuyệt đối ẩn danh tính người báo cáo**) và kết quả khiếu nại (`APPEAL_DECISION`) tới hộp thư chuông trên giao diện chính (kèm email không chặn nếu SMTP khả dụng).
- **Luồng Khiếu nại (Appeals) khép kín**:
  - Quản trị viên tra cứu danh sách khiếu nại qua `GET /api/v1/admin/appeals`.
  - Phê duyệt / từ chối khiếu nại qua `POST /api/v1/admin/appeals/:id/resolve`.
  - Khi phê duyệt khiếu nại (`APPROVE`), hệ thống tự động gỡ bỏ hạn chế tài khoản cho người dùng.

### 4. Phòng chống lạm dụng & Giới hạn tần suất (Anti-Abuse Rate Limiting)
- Triển khai cơ chế Sliding-Window Rate Limiting in-memory / Redis:
  - Đăng ký / Đăng nhập: Tối đa 15 yêu cầu / phút trên mỗi IP.
  - Quên mật khẩu: Tối đa 5 yêu cầu / phút trên mỗi IP.
  - Gửi lời mời kết bạn: Tối đa 10 yêu cầu / phút trên mỗi người dùng.
  - Gửi báo cáo vi phạm: Tối đa 5 báo cáo / phút.
  - Gửi đơn khiếu nại: Tối đa 3 đơn / phút.

### 5. Trải nghiệm lõi & Ngụy trang Stealth Vault
- **Bỏ con số ảo**: Thay thế chuỗi *"1,420+ người đang tìm bạn"* bằng thông điệp trung thực: *"Sẵn sàng kết nối • Ghép đôi 1–1"*.
- **Chế độ Ngụy trang (Stealth Vault)**:
  - Cài đặt mã PIN 4 chữ số trong Hồ sơ (`POST /api/v1/users/me/stealth-vault/unlock` cấp cookie `HttpOnly SameSite=Strict`, không trả `vaultToken` ra JS).
  - `GET /api/v1/users/me/stealth-vault` trả thêm trường `unlocked` xác thực trực tiếp từ cookie trên máy chủ, giữ nguyên trạng thái mở khóa chính xác sau khi reload trang (fail-closed nếu cookie hết hạn).
- **Xử lý Media An Toàn (Ảnh & Video Worker Độc Lập)**:
  - Upload lớn tới 100 MB (video) và 30 MB (ảnh) kiểm tra toàn vẹn AES-256-GCM và magic bytes qua temp-file/streaming (< 1 MB JS heap), không buffer nguyên tệp giải mã vào RAM API.
  - Ảnh giới hạn `4096×4096` (~16.77 MP) ở cả lúc `completeUpload` (`415`) lẫn `openStream`, tự resize watermark output `<= 2048px`, bảo vệ bởi `SharpProcessingSemaphore` (`SHARP_CONCURRENCY=1`, hàng đợi giới hạn trả `503`) và lưu cache biến thể theo người nhận ở bảng `media_watermarked_variants`.
  - Worker video (`media-worker.process.ts`) chạy dịch vụ/container riêng (`EMBEDDED_MEDIA_WORKER=false` mặc định, `docker-compose.yml` service `media-worker` `restart: unless-stopped`, `mem_limit: 768m`), kiểm tra FFmpeg khi khởi động + phát heartbeat Redis định kỳ 5s; `/health` & `/ready` và API `/view-token` trả `503` rõ ràng nếu worker chết hoặc thiếu FFmpeg (không để video treo `PENDING`/`PROCESSING`). Chế độ fork nhúng dev (`EMBEDDED_MEDIA_WORKER=true`) giám sát `exit`/`error` và restart theo exponential backoff.
- **An Toàn & Kiểm Duyệt Cho Nhóm Cộng Đồng + Tách Cookie CSRF**:
  - Thành viên có thể Báo cáo vi phạm (`POST /api/v1/groups/:roomId/messages/:messageId/report`) kèm bằng chứng đóng băng 90 ngày và Chặn tác giả tin nhắn (`POST /api/v1/groups/:roomId/messages/:messageId/block`).
  - Lịch sử phòng nhóm & Socket.IO real-time tự động ẩn tin nhắn giữa các bên đã chặn nhau theo cơ chế **fail-closed** (tuyệt đối không fallback phát toàn phòng nếu Redis/DB lỗi; ghi metric `failClosedAborts` và đẩy vào hàng đợi retry có kiểm soát).
  - Tách riêng cookie `chatible_admin_csrf` khỏi `chatible_csrf` để đăng xuất Admin không bao giờ làm hỏng phiên người dùng trên cùng domain.
- **Checklist Hạ Tầng Go-Live Thực Tế (Production Operations)**:
  - **Phân quyền DB Role**: Tài khoản PostgreSQL của ứng dụng/ORM chỉ được cấp quyền thông thường (`SELECT`, `INSERT` trên `audit_logs`), **không dùng role superuser hoặc table owner** để bảo đảm trigger append-only không thể bị vô hiệu hóa ở runtime.
  - **S3 Object Lock WORM**: Bật S3 Object Lock (Governance/Compliance mode) cho bucket xuất bản sao `audit_logs` phục vụ kiểm toán độc lập ngoài DB.
  - **Khóa Production Bắt Buộc**: Cấu hình `ADMIN_TOTP_SECRET` (Base32 >= 16 ký tự), `KMS_PROVIDER=aws-kms`, `AWS_KMS_KEY_ID`, `S3_ENDPOINT` (`https://...`), và cân nhắc tách container riêng cho `npm --workspace=backend run worker:media`.

---

## 🧪 Kết Quả Kiểm Thử Tự Động (Automated Test Suite)

Toàn bộ test suite được chạy trên môi trường Bun Test với PostgreSQL, Redis, FFmpeg và Google Chrome thật (Headless CDP):

```bash
bun test v1.4.2
- src/matching/matching.spec.ts: 7 tests passed
- src/kms/cloud-kms.spec.ts: 2 tests passed (AWS Cloud KMS wrap/unwrap + audit hooks, Production HTTPS S3, Cloud KMS & ADMIN_TOTP_SECRET validation)
- src/crypto/envelope.spec.ts: 3 tests passed
- src/auth/auth.spec.ts: 16 tests passed (Xác minh email OTP + cooldown 60s, Quên MK, Đổi MK, Xóa tài khoản, Rate limit, Google Auth Config, 18+, Stealth PIN)
- src/auth/session-security.spec.ts: 2 tests passed (Cookie-only HttpOnly web auth, từ chối Bearer & token JSON, CSRF/Origin, Vault 423 + reload unlocked, Logout revocation, Redis limiter)
- src/mail/mail.spec.ts: 2 tests passed (Mã hóa KMS mật khẩu SMTP, che giấu API, test SMTP, gửi OTP xác minh email & đặt lại mật khẩu tự động)
- src/admin/admin-hardening.spec.ts: 2 tests passed (TOTP MFA, chặn tắt MFA 403, cookie 15p Strict + CSRF, giải mã media Admin, chuỗi băm audit & E2E trên Chrome thật: login ➔ mở bằng chứng ➔ xử lý report)
- src/admin/admin.controller.spec.ts: 4 tests passed (Cookie-only + tách biệt `chatible_admin_csrf`, `IN_REVIEW` report route, Report resolution, Group takedown, Appeals, System Settings)
- src/groups/groups.spec.ts: 1 test passed (BROADCAST chỉ Admin đăng, PUBLIC, PRIVATE_PASSCODE 403/unlock, Báo cáo/Chặn trong Nhóm & Admin gỡ tin)
- src/safety/safety.spec.ts: 5 tests passed (Blocking, Evidence, Appeals, `IN_REVIEW` & Safety Notifications ẩn danh người tố cáo)
- src/realtime/chat.gateway.spec.ts: 4 tests passed (Cookie-only Socket.IO handshake, Multi-node gateway, chặn ghép đôi khi bật bắt buộc xác minh email, Socket lifecycle, clientMessageId idempotency, kiểm mediaId READY, fail-closed emitGroupMessage & retry)
- src/sessions/recent-sessions.controller.spec.ts: 1 test passed
- src/friends/friends.spec.ts: 5 tests passed (Offline messages, Request cooldowns, Media 1-1 & 18+)
- src/cron/cleanup.spec.ts: 4 tests passed (Data retention, Storage safety, dọn phiên FRIEND & tin nhóm hết hạn)
- src/media/media-worker.spec.ts: 1 test passed (Streaming GCM/magic-byte check, heartbeat worker & FFmpeg 503 readiness guard, 202 PROCESSING + Redis semaphore=1, FFmpeg worker offload, variant cache stream)
- src/media/media.spec.ts: 11 tests passed (Complete upload & magic bytes, chặn bom ảnh >4096px/16.7MP, orphan cleanup, quyền 18+ & cam kết người gửi, watermark pixel thực tế, cache variant & SharpProcessingSemaphore 503)

Tổng cộng: 70 pass / 0 fail / 554 expect() calls (16 files — 100% PASS)
Typecheck: 0 lỗi trên toàn bộ monorepo (shared, backend, frontend)
ESLint: 0 cảnh báo (--max-warnings=0)
Production Build: Thành công 100% (shared, backend, frontend)
```

---

## 📈 Kế Hoạch Thử Nghiệm Kín (Pre-Beta Pilot Framework & Metrics)

Để đánh giá sản phẩm trước khi mở rộng sang ứng dụng Native Mobile hay tính năng nâng cao, nhóm vận hành sẽ theo dõi 5 chỉ số then chốt trên nhóm người dùng thử nghiệm ban đầu (tập trung theo khung giờ vàng 20:00 – 23:00):

1. **Chỉ số Kích hoạt (Activation Rate)**:
   - Tỷ lệ người đăng ký mới hoàn tất thiết lập hồ sơ (biệt danh, giới tính, ngày sinh) và bắt đầu bấm "Tìm bạn".
2. **Khả năng ghép đôi (Matchability)**:
   - Tỷ lệ các lượt tìm bạn có kết quả ghép đôi thành công trong vòng 60 giây.
   - Thời gian chờ trung bình theo từng bộ lọc (Tất cả / Nam / Nữ).
3. **Chất lượng cuộc trò chuyện (Session Quality)**:
   - Thời lượng trò chuyện trung bình (phút/phiên).
   - Số lượng tin nhắn văn bản trao đổi hai chiều trước khi kết thúc phiên.
   - Tỷ lệ phiên đạt mốc gửi lời mời kết bạn.
4. **An toàn & Báo cáo (Safety & Moderation SLA)**:
   - Tỷ lệ phiên phát sinh báo cáo vi phạm (< 2% tổng số phiên).
   - Thời gian phản hồi xử lý báo cáo khẩn cấp (`URGENT` < 30 phút, `HIGH` < 4 giờ).
5. **Độ tin cậy kỹ thuật (Reliability)**:
   - Tỷ lệ ngắt kết nối WebSocket bất thường (không do người dùng chủ động bấm Rời).
   - Tỷ lệ tái kết nối thành công trong cửa sổ 30 giây khi mạng chập chờn.
