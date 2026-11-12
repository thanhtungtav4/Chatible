# Đặc tả Giao tiếp API & Sự kiện WebSocket (Contract Specification)

**Dự án**: Chatible — Fullstack Web & Mobile App  
**Giao thức**: HTTPS (REST API) + WSS (WebSocket / Socket.io)  

---

## 1. REST API Endpoints

### 1.1 Xác thực & Quản lý Tài khoản (Auth & Profile)

#### `POST /api/v1/auth/register`
Đăng ký tài khoản với ràng buộc tuổi từ 18 trở lên.
- **Request Body**:
```json
{
  "email": "user@example.com",
  "password": "StrongPassword123!",
  "birth_date": "2004-03-15",
  "gender": "MALE",
  "nickname": "Hoàng Long",
  "policy_accepted": true
}
```
- **Response `201 Created`**:
```json
{
  "status": "success",
  "message": "Đăng ký thành công. Vui lòng xác thực email.",
  "user_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
}
```
- **Error `400 Bad Request`**: `"Người dùng phải từ đủ 18 tuổi trở lên."` hoặc `"Email đã tồn tại."`

#### `POST /api/v1/auth/login`
Đăng nhập tài khoản bằng email & mật khẩu hoặc Google OAuth Token.
- **Request Body**:
```json
{
  "email": "user@example.com",
  "password": "StrongPassword123!"
}
```
- **Response `200 OK`**:
```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "profile": {
    "nickname": "Hoàng Long",
    "gender": "MALE",
    "age": 22,
    "preferred_gender": "ALL",
    "preferred_age_min": 18,
    "preferred_age_max": 30
  }
}
```

---

### 1.2 Tải lên Media Mã hóa (Media Upload & Ephemeral View)

#### `POST /api/v1/media/presign-upload`
Yêu cầu URL tải lên ciphertext tới S3/R2. Tất cả endpoint media yêu cầu `Authorization: Bearer <JWT>`.
- **Request Body** (camelCase; backend cũng nhận snake_case):
```json
{
  "sessionId": "session-uuid",
  "recipientId": "recipient-uuid",
  "contentType": "image/webp",
  "fileSize": 450200,
  "mediaType": "IMAGE",
  "dek": "<base64 của DEK AES-GCM 32 byte>",
  "iv": "<base64 IV 12 byte>",
  "authTag": "<base64 auth tag 16 byte>",
  "isAdult": false
}
```
- Sender và recipient phải là hai thành viên của phiên chưa hết hạn; recipient phải bật consent nhận media.
- Client mã hóa tệp bằng AES-GCM trước khi PUT. `fileSize` là kích thước ciphertext.
- Server dùng KMS bọc DEK trước khi lưu metadata; KMS-wrapped DEK không được trả về client.
- **Response `200 OK`**:
```json
{
  "media_id": "media-uuid",
  "upload_url": "https://storage.chatible.app/media/...",
  "expires_at": "2026-06-19T12:00:00.000Z"
}
```
- PUT ciphertext tới `upload_url` với `Content-Type: application/octet-stream`.

#### `POST /api/v1/media/consent`
Người nhận bật/tắt quyền nhận media cho phiên của mình:
```json
{ "sessionId": "session-uuid", "enabled": true }
```

#### `GET /api/v1/media/:media_id/view-token`
Cấp token xem ngắn hạn sau khi xác thực thành viên phiên, consent và object đã tải lên. Token sống 5 phút.
- **Response `200 OK`**: gồm `view_token`, `dek` (DEK thô, base64), watermark và thông tin giải mã. Server chỉ mở bọc DEK sau khi xác thực người xem, consent và object đã tải lên; phản hồi đặt `Cache-Control: private, no-store`. KMS-wrapped DEK không bao giờ trả về client.
Tin nhắn chat chỉ chứa metadata `media_id` và loại media; client lấy DEK qua endpoint này khi cần xem.
```json
{
  "view_token": "mvt_...",
  "dek": "<base64 DEK AES-GCM 32 byte>",
  "watermark_text": "Chatible • Recipient Trace #9941",
  "expires_in": 300,
  "content_type": "image/webp",
  "media_type": "IMAGE",
  "iv": "<base64>",
  "auth_tag": "<base64>"
}
```

#### `GET /api/v1/media/stream/:media_id`
Trả ciphertext, không trả URL kho vĩnh viễn. Gửi JWT trong `Authorization` và view token trong header `X-Media-View-Token`; **không gửi token qua query string** để tránh lưu vào URL/access log.

#### `POST /api/v1/media/:media_id/revoke`
Chỉ sender được thu hồi media. Thu hồi vô hiệu hóa các view token hiện hành và xóa object khỏi kho; nếu xóa thất bại, quyền xem vẫn bị thu hồi và cron sẽ thử lại. Consent bị tắt cũng chặn cấp/xử lý token xem.
---

### 1.3 Phiên Gần đây & Báo cáo (Recent Sessions & Safety)

#### `GET /api/v1/sessions/recent`
Lấy các phiên chat ngẫu nhiên đã kết thúc, còn trong thời hạn lưu trữ 7 ngày. Phiên đang hoạt động, phiên bạn bè và phiên hết hạn không xuất hiện.
- **Response `200 OK`**:
```json
{
  "sessions": [
    {
      "id": "session-uuid",
      "partnerId": "user-uuid",
      "partnerName": "Bảo Ngọc",
      "partnerGender": "Nữ",
      "partnerAge": 20,
      "messagesCount": 18,
      "endedAt": "2026-11-08T10:30:00Z",
      "expiresAt": "2026-11-15T10:30:00Z",
      "remainingDays": 7
    }
  ]
}
```
Tài khoản đã xác thực có thể gửi lời mời kết bạn tới `partnerId` bằng `POST /api/v1/friends/request` khi phiên còn hiệu lực.

#### `POST /api/v1/reports`
Báo cáo vi phạm và đóng băng bằng chứng trong suốt thời gian xử lý, rồi giữ thêm 90 ngày sau khi đóng.
- **Request Body**:
```json
{
  "session_id": "RC-9941",
  "reason": "HARASSMENT",
  "description": "Đối tác gửi nội dung không phù hợp",
  "evidence_message_ids": ["msg-01", "msg-02"]
}
```
- **Response `201 Created`**:
```json
{
  "status": "success",
  "report_id": "rep-7890",
  "message": "Bằng chứng đã được đóng băng thành công và chuyển tới điều hành viên."
}
```

### 1.4 Bạn bè và tin nhắn riêng (Friends)

Các endpoint dưới đây yêu cầu `Authorization: Bearer <access_token>`.

#### `GET /api/v1/friends`
Trả về danh sách bạn bè đã xác nhận.

#### `GET /api/v1/friends/requests`
Trả về lời mời đang chờ được gửi tới tài khoản hiện tại:
```json
{
  "requests": [
    {
      "requestId": "fr-123",
      "fromUserId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "nickname": "Hoàng Long",
      "gender": "MALE",
      "age": 22,
      "sentAt": "2026-11-08T10:30:00Z"
    }
  ]
}
```

#### `POST /api/v1/friends/accept`
Chấp nhận lời mời cho tài khoản đã xác thực.
```json
{ "requestId": "fr-123" }
```

#### `GET|POST /api/v1/friends/:friendId/messages`
Đọc hoặc gửi tin nhắn riêng tới một người bạn đã xác nhận.

---

## 2. Đặc tả Sự kiện WebSocket (Real-time Events Contract)

### 2.1 Hàng chờ Ghép đôi (Matching Events)

| Sự kiện (Event Name) | Chiều gửi | Dữ liệu Payload | Mô tả |
|---|---|---|---|
| `matching:join` | Client ➔ Server | `{ target_gender: "ALL", age_min: 18, age_max: 30 }` | Người dùng bấm Bắt đầu tìm bạn mới. |
| `matching:cancel` | Client ➔ Server | `{}` | Hủy tìm kiếm khi đang trong hàng chờ. |
| `matching:expand_accept` | Client ➔ Server | `{}` | Chấp nhận mở rộng bộ lọc sau 6s chờ. |
| `matching:found` | Server ➔ Client | `{ partner: { nickname: "Minh Thư", gender: "FEMALE", age: 21 } }` | Đã ghép thành công, chuyển sang MATCHING. |
| `matching:ready` | Client ➔ Server | `{}` | Thiết bị xác nhận sẵn sàng bước vào chat. |

### 2.2 Vòng đời Chat & Tin nhắn (Chat & Message Events)

| Sự kiện (Event Name) | Chiều gửi | Dữ liệu Payload | Mô tả |
|---|---|---|---|
| `chat:start` | Server ➔ Client | `{ session_id: "RC-9941", partner_info: {...} }` | Hai bên đã sẵn sàng, vào trạng thái CHATTING. |
| `message:send` | Client ➔ Server | `{ type: "TEXT", encrypted_payload: {...}, iv: "..." }` | Gửi tin nhắn (đã mã hóa envelope). |
| `message:receive` | Server ➔ Client | `{ id: "msg-123", sender: "partner", type: "TEXT", ... }` | Nhận tin nhắn từ đối phương. |
| `media:consent_request`| Client ➔ Server | `{}` | Yêu cầu đối phương bật quyền nhận media trong chat lạ. |
| `media:consent_response`| Client ➔ Server | `{ accepted: true }` | Người nhận đồng ý nhận ảnh/video. |
| `chat:next` | Client ➔ Server | `{}` | Bấm "Chuyển người": Dừng phiên cũ, đưa vào hàng chờ mới. |
| `chat:end` | Client ➔ Server | `{ reason: "USER_LEFT" }` | Bấm "Kết thúc" cuộc trò chuyện. |
| `chat:ended` | Server ➔ Client | `{ reason: "PARTNER_LEFT" }` | Thông báo cho phía còn lại chuyển sang trạng thái ENDED. |
| `connection:lost` | Server ➔ Client | `{ timeout_sec: 30 }` | 1 bên mất mạng, kích hoạt đếm ngược 30s RECONNECTING. |
| `connection:restored` | Server ➔ Client | `{}` | Khôi phục lại trạng thái CHATTING khi kết nối lại kịp thời. |

### 2.3 Kết bạn Thời gian thực (Friendship Events)

| Sự kiện (Event Name) | Chiều gửi | Dữ liệu Payload | Mô tả |
|---|---|---|---|
| `friend:request_send` | Client ➔ Server | `{ target_user_session: "RC-9941" }` | Gửi lời mời kết bạn từ thanh hành động kết thúc. |
| `friend:request_received` | Server ➔ Client | `{ from_nickname: "Hoàng Long" }` | Thông báo lời mời kết bạn đến đối phương. |
| `friend:request_accept` | Client ➔ Server | `{ request_id: "fr-123" }` | Đồng ý kết bạn, kích hoạt quyền chat offline 1-1. |
