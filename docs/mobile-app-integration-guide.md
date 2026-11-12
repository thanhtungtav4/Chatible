# Hướng Dẫn Kế Thừa & Khởi Tạo Mobile App (Expo / React Native)

**Dự án**: Chatible — Fullstack Web ➔ Mobile App Ready  
**Mục tiêu**: Kế thừa 100% Backend và 80% logic nghiệp vụ từ Web sang Mobile App mà không phải viết lại API hay sửa cấu trúc dữ liệu.

---

## 1. Khởi tạo Dự án Mobile App (Expo SDK 52+)

Trong thư mục gốc Monorepo `Chatible/`, khởi tạo thư mục ứng dụng di động `app/`:

```bash
# Khởi tạo Expo App với TypeScript
npx create-expo-app@latest app --template default
```

Cập nhật `package.json` ở thư mục gốc Monorepo để bao gồm `app`:
```json
"workspaces": [
  "shared",
  "backend",
  "frontend",
  "app"
]
```

---

## 2. Kết nối Thư viện Dùng Chung `@chatible/shared`

Trong `app/package.json`, thêm phụ thuộc nội bộ:
```json
{
  "dependencies": {
    "@chatible/shared": "workspace:*",
    "socket.io-client": "^4.8.1",
    "zustand": "^5.0.2"
  }
}
```

Sau đó chạy lệnh cài đặt:
```bash
bun install
```

---

## 3. Tái sử dụng Trực tiếp Hợp đồng Dữ liệu & Sự kiện Realtime

Nhờ kiến trúc Monorepo, mã nguồn Mobile App có thể import trực tiếp 100% kiểu dữ liệu và sự kiện từ `@chatible/shared`:

```typescript
// app/src/hooks/useChatSocket.ts
import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { SocketEvents, ChatState, UserPublicProfile } from '@chatible/shared';

const BACKEND_URL = 'https://api.chatible.app'; // hoặc http://10.0.2.2:3000 cho Android emulator

export function useChatSocket(userId: string) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [chatState, setChatState] = useState<ChatState>('IDLE');
  const [partner, setPartner] = useState<UserPublicProfile | null>(null);

  useEffect(() => {
    const s = io(BACKEND_URL, {
      transports: ['websocket'],
    });

    s.on(SocketEvents.MATCHING_FOUND, ({ partner }) => {
      setPartner(partner);
      setChatState('CHATTING');
    });

    s.on(SocketEvents.CONNECTION_LOST, () => {
      setChatState('RECONNECTING');
    });

    s.on(SocketEvents.CHAT_ENDED, () => {
      setChatState('ENDED');
    });

    setSocket(s);
    return () => {
      s.disconnect();
    };
  }, [userId]);

  return { socket, chatState, partner };
}
```

---

## 4. Các Thư viện Native Khuyên dùng cho Mobile App

| Chức năng | Thư viện Expo đề xuất |
|---|---|
| **Ghi âm Waveform Audio** | `expo-av` hoặc `react-native-audio-recorder-player` |
| **Chụp ảnh & Chọn Media** | `expo-image-picker` |
| **Lưu trữ Cục bộ Bảo mật (PIN ngụy trang)** | `expo-secure-store` |
| **Thông báo Đẩy (Push Notifications)** | `expo-notifications` |
| **Biểu tượng UI (Icons)** | `lucide-react-native` (hoàn toàn tương đồng với Web) |

---

## 5. Danh Mục REST API Đầy Đủ Cho Mobile App

Tất cả các API được tiền tố `/api/v1` và yêu cầu header `Authorization: Bearer <jwt_token>` (ngoại trừ các endpoint đăng ký/đăng nhập công khai):

| Phương thức | Đường dẫn | Chức năng | Body / Params |
|---|---|---|---|
| **POST** | `/api/v1/auth/register` | Đăng ký tài khoản (xác minh 18+) | `{ email, password, nickname, gender, birthDate }` |
| **POST** | `/api/v1/auth/login` | Đăng nhập tài khoản | `{ email, password }` |
| **POST** | `/api/v1/auth/google` | Đăng nhập Google OAuth (18+) | `{ idToken, birthDate?, gender?, nickname? }` |
| **GET** | `/api/v1/users/me` | Lấy hồ sơ cá nhân & cài đặt ghép đôi | Không |
| **PUT** | `/api/v1/users/profile` | Cập nhật hồ sơ & bộ lọc ghép đôi | `{ nickname?, preferredGender?, preferredAgeMin?, preferredAgeMax?, mediaConsentDefault? }` |
| **GET** | `/api/v1/users/:userId/public` | Lấy hồ sơ công khai (chỉ nickname, tuổi, giới tính) | `:userId` |
| **GET** | `/api/v1/friends` | Danh sách bạn bè | Không |
| **GET** | `/api/v1/friends/requests` | Danh sách lời mời kết bạn nhận được | Không |
| **POST** | `/api/v1/friends/request` | Gửi lời mời kết bạn (cooldown 7 ngày nếu bị từ chối) | `{ targetUserId }` |
| **POST** | `/api/v1/friends/accept` | Chấp nhận lời mời kết bạn | `{ requestId }` |
| **POST** | `/api/v1/friends/decline` | Từ chối lời mời kết bạn | `{ requestId }` |
| **DELETE** | `/api/v1/friends/requests/:requestId` | Thu hồi/hủy lời mời đang chờ | `:requestId` |
| **DELETE** | `/api/v1/friends/:friendId` | Hủy kết bạn (unfriend) | `:friendId` |
| **GET** | `/api/v1/friends/:friendId/messages` | Tải tin nhắn bạn bè 1-1 (lưu trữ 30 ngày) | `:friendId` |
| **POST** | `/api/v1/friends/:friendId/messages` | Gửi tin nhắn bạn bè 1-1 | `:friendId`, `{ content }` |
| **GET** | `/api/v1/blocks` | Danh sách người dùng bị chặn | Không |
| **POST** | `/api/v1/blocks` | Chặn người dùng 2 chiều | `{ targetUserId }` |
| **DELETE** | `/api/v1/blocks/:targetUserId` | Bỏ chặn người dùng | `:targetUserId` |
| **POST** | `/api/v1/reports` | Gửi báo cáo vi phạm kèm đóng băng bằng chứng KMS | `{ sessionId, reportedUserId, reason, description?, evidenceMessages }` |
| **POST** | `/api/v1/appeals` | Nộp đơn khiếu nại tài khoản bị hạn chế (PRO-05) | `{ reason }` (tối thiểu 10 ký tự) |
| **GET** | `/api/v1/sessions/recent` | Danh sách phiên chat ngẫu nhiên còn hạn 7 ngày | Không |
| **GET** | `/api/v1/sessions/:sessionId/messages` | Lấy tin nhắn đã giải mã của phiên gần đây | `:sessionId` |
| **POST** | `/api/v1/media/consent` | Cấp/thu hồi quyền nhận ảnh/media trong phiên | `{ sessionId, enabled }` |
| **POST** | `/api/v1/media/presign-upload` | Cấp URL upload media mã hóa phía client (AES-256-GCM) | `{ sessionId, recipientId, contentType, fileSize, mediaType, dek, iv, authTag }` |
| **POST** | `/api/v1/media/view-token` | Xin token xem media nhạy cảm (5 phút) | `{ mediaId }` |
| **GET** | `/api/v1/media/:mediaId/stream` | Stream ciphertext media (yêu cầu `X-Media-View-Token`) | `:mediaId` |
| **DELETE** | `/api/v1/media/:mediaId` | Thu hồi media (xóa token và object nếu không phải bằng chứng) | `:mediaId` |

---

## 6. Kiểm thử & Chạy Ứng dụng Di động

```bash
cd app
bun run start
# Quét mã QR trên iPhone (Expo Go) hoặc thiết bị Android để chạy thử trực tiếp
```
