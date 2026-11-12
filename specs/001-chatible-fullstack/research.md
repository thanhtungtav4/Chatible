# Nghiên cứu Kỹ thuật & Quyết định Kiến trúc (Technical Research)

**Dự án**: Chatible — Fullstack Web & Định hướng Mobile App  
**Tài liệu gốc**: `docs/dac-ta-nghiep-vu-v1.1.md` và `.specify/memory/constitution.md`  

---

## 1. Quyết định Công nghệ: Frontend Web ➔ Mobile App

### Bối cảnh & Mục tiêu
- **Giai đoạn hiện tại**: Phát triển ứng dụng Web hoàn chỉnh (tối ưu hóa giao diện di động, trải nghiệm mượt mà, hỗ trợ cài đặt dạng PWA).
- **Giai đoạn tiếp theo**: Phát triển ứng dụng Native Mobile (iOS và Android).
- **Yêu cầu then chốt**: Không phải đập đi xây lại Backend khi làm App; tái sử dụng tối đa logic nghiệp vụ, models, state management và giao thức realtime.

### So sánh & Đánh giá các phương án

| Tiêu chí | Phương án A: React/Next.js (Web) + React Native/Expo (App) ⭐ | Phương án B: Flutter (Flutter Web + Flutter Mobile) |
|---|---|---|
| **Hiệu năng Web** | ⚡ **Xuất sắc**: Bundle nhẹ (< 200KB initial), DOM rendering mượt mà, load tức thì trên 4G/5G. | ⚠️ **Hạn chế**: Tải file engine CanvasKit/WASM (~3-5MB), khởi động chậm trên di động mạng yếu. |
| **Tái sử dụng Code** | 75–80% logic (TypeScript DTOs, Zustand Store, WebSocket Client, Web Crypto, Auth logic). | 90–95% cả UI lẫn logic (viết 1 lần bằng Dart). |
| **Trải nghiệm App sau này** | Rất tốt với Expo SDK 52+ & React Native New Architecture (Fabric + TurboModules). | Rất tốt với Skia Rendering Engine của Flutter. |
| **Hệ sinh thái Realtime & Media** | Cực kỳ phong phú (Socket.io, WebRTC, Opus recorder, WebP canvas compressor). | Tốt, nhưng nhiều plugin WebRTC/Media trên Web bị hạn chế hơn Mobile. |

**Quyết định**: Chọn **Phương án A (React/Next.js + Tailwind CSS cho Web, kết hợp module dùng chung `shared/` để kế thừa sang Expo/React Native khi làm App)**.

---

## 2. Thiết kế Matching Engine thời gian thực (Redis)

### Bài toán nghiệp vụ
- Khách hàng bấm **"Bắt đầu tìm bạn mới"**:
  - Tiêu chí A: Giới tính của A, giới tính A muốn tìm (Nam/Nữ/Khác/Tất cả), khoảng tuổi A muốn tìm (18–30t).
  - Tiêu chí B: Tương tự.
  - Điều kiện ghép hợp lệ: $A \cap B$ thỏa mãn đồng thời 2 chiều (Giới tính A $\in$ Tập B cho phép VÀ Giới tính B $\in$ Tập A cho phép VÀ Tuổi A $\in$ Khoảng B chọn VÀ Tuổi B $\in$ Khoảng A chọn).
  - Tránh ghép lại đối tác vừa mới chat trong vòng $N$ phút.
  - Tự động mở rộng bộ lọc sau 6–10 giây nếu hàng chờ ít người.

### Giải pháp kỹ thuật với Redis 7
- **Cấu trúc dữ liệu**: Dùng **Redis Sorted Sets (ZSET)** và **Hashes**.
  - `match:queue:<gender_target>:<gender_self>`: Key lưu danh sách người đang chờ, Score là timestamp vào hàng chờ (ưu tiên người chờ lâu nhất - FIFO).
  - `match:user:<user_id>`: Hash lưu thông tin bộ lọc (tuổi bản thân, khoảng tuổi tìm kiếm, danh sách user vừa ghép để loại trừ).
- **Cơ chế khóa & chống tranh chấp (Concurrency Lock)**:
  - Dùng **Lua Script nguyên tử (Atomic Lua Script)** để tìm cặp hợp lệ và nhấc cả 2 người dùng ra khỏi hàng chờ cùng lúc (`RESERVED`).
  - Đảm bảo 100% không bao giờ xảy ra tình trạng 1 người bị ghép với 2 người khác nhau cùng một tích tắc.

---

## 3. Kiến trúc Mã hóa Envelope Encryption (Local KMS Provider & Master KEK Độc Lập)

### Bối cảnh Ngân sách & Ràng buộc Hiến pháp
- **Bối cảnh**: Dự án giai đoạn đầu triển khai trên hạ tầng tối ưu chi phí ($0 ngân sách cho Cloud KMS hàng tháng, chạy trên 1 VPS/node ứng dụng).
- **Mục tiêu cốt lõi của Hiến pháp (`constitution.md`)**:
  - Toàn bộ tin nhắn chữ, ảnh, voice ghi âm, video clip và bằng chứng báo cáo phải được mã hóa tầng ứng dụng.
  - **Phòng thủ rò rỉ Database (Database Dump Protection)**: Nếu cơ sở dữ liệu PostgreSQL bị rò rỉ hoặc bị dump (qua SQLi, lộ file backup), kẻ tấn công **tuyệt đối không thể giải mã** dữ liệu vì Master Key (KEK) không nằm trong database.
  - Mỗi đối tượng dữ liệu được mã hóa bằng một Data Encryption Key (DEK) riêng biệt; DEK được bọc bởi KEK (`encrypted_dek`).
  - Không lưu DEK rõ trong cơ sở dữ liệu.

### Quyết định Kỹ thuật: Local KMS Provider ($0 Cost, Zero Dependency)
- Thay vì phụ thuộc dịch vụ tính phí Cloud KMS (AWS/GCP KMS) ở giai đoạn đầu, hệ thống thiết kế kiến trúc cắm/rút trừu tượng với interface `IKmsProvider`:

```typescript
export interface IKmsProvider {
  wrapKey(plaintextDek: Buffer): Promise<Buffer>;   // Bọc DEK bằng KEK
  unwrapKey(encryptedDek: Buffer): Promise<Buffer>; // Mở DEK bằng KEK
}
```

- **Cơ chế lưu trữ Master KEK**:
  - KEK (256-bit AES Key) được khởi tạo độc lập và truyền vào qua **OS Environment Variable** (`APP_MASTER_KEK=...`) hoặc lưu tại file hệ thống có quyền bảo mật nghiêm ngặt (`/etc/chatible/master.key` với quyền `chmod 400`, chỉ user chạy backend service được đọc).
  - **Tuyệt đối không lưu KEK trong PostgreSQL, mã nguồn Git hay log ứng dụng**.

### Luồng xử lý Mã hóa & Giải mã
```text
[Client] Gửi tin nhắn ➔ [Server API / WebSocket Gateway]
                            │
                            ├─ 1. Sinh DEK ngẫu nhiên (AES-256 key: 32 bytes cryptographically secure)
                            ├─ 2. Gửi DEK qua LocalKmsProvider:
                            │     ➔ Dùng Master KEK bọc DEK bằng thuật toán AES-KeyWrap (NIST SP 800-38F) hoặc AES-256-GCM
                            │     ➔ Thu được `encrypted_dek`
                            ├─ 3. Mã hóa nội dung tin/media bằng AES-256-GCM với DEK rõ
                            │     ➔ Nhận về `ciphertext` + `auth_tag` + `iv`
                            ├─ 4. Xóa DEK rõ khỏi bộ nhớ RAM ngay lập tức
                            └─ 5. Lưu vào PostgreSQL/S3:
                                  { encrypted_dek, iv, auth_tag, ciphertext }
```
Khi đọc tin nhắn: `LocalKmsProvider.unwrapKey(encrypted_dek)` mở lại DEK trong RAM để giải mã nội dung và đẩy về client qua kênh WSS bảo mật.

### Lộ trình Nâng cấp Cloud KMS (Seamless Upgrade)
Khi dự án có doanh thu/kinh phí tài trợ Cloud:
1. Viết thêm class `AwsKmsProvider` (triển khai cùng interface `IKmsProvider`).
2. Đổi biến cấu hình `KMS_DRIVER=aws` trong `.env`.
3. **Toàn bộ cấu trúc bảng cơ sở dữ liệu PostgreSQL (`messages`, `report_evidence`) và giao diện Frontend giữ nguyên 100% không cần sửa đổi.**

## 4. Pipeline Media, Nén Client-Side & Watermark Động

- **Nén ảnh trước khi gửi (Client-Side Compression)**:
  - Trình duyệt dùng Canvas API / `browser-image-compression` để nén ảnh về chuẩn WebP, dung lượng mục tiêu ~300KB – 800KB, kích thước tối đa 1920px.
  - Lợi ích: Tiết kiệm 85% băng thông mạng di động và giảm tải CPU cho server.
- **Audio Voice Recording**:
  - Ghi âm qua MediaRecorder API chuẩn định dạng `audio/webm;codecs=opus` (hoặc `audio/mp4;codecs=aac` cho iOS Safari).
  - Tự động sinh danh sách 30 điểm biên độ sóng âm (waveform array) gửi kèm tin nhắn để hiển thị thanh sóng động không cần tải toàn bộ tệp âm thanh.
- **Watermark động cho nội dung người lớn (18+)**:
  - Gắn lớp phủ bán trong suốt chứa mã định danh phiên ngẫu nhiên (Session Trace Token) mờ, giúp truy vết nếu bị quay/chụp màn hình phát tán mà không làm lộ email hay danh tính thật.
- **Xem qua Token mờ hạn ngắn**:
  - Không cung cấp link tải trực tiếp. Ảnh/video nhạy cảm chỉ xem qua Presigned URL có thời hạn đúng 5 phút (`expires_in: 300`).

---

## 5. Chế độ Ngụy trang Stealth Vault (Tìm kiếm bằng Passcode)

- **Cơ chế hoạt động**:
  - Cấu hình lưu trữ tại `localStorage` (`chatx_stealth_enabled`, `chatx_stealth_pass`).
  - Mặc định khi mở ứng dụng: Trạng thái `isUnlocked = false`.
  - Màn hình "Gần đây" (`screen-recent`) tự động hiển thị giao diện rỗng/ngụy trang an toàn.
  - Người dùng gõ mật mã (mặc định: `8888`) vào ô tìm kiếm:
    - Nhận diện chuỗi khớp ➔ Xóa trắng ô tìm kiếm lập tức ➔ Đổi `isUnlocked = true`.
    - Kích hoạt animation `reveal-anim` hiển thị danh sách phiên gần đây thật.
    - Xuất hiện nút `[ 🔒 Khóa ]` tích hợp bên phải ô input để khóa lại tức thì.
