# Mô hình Dữ liệu Nghiệp vụ (Data Model Specification)

**Dự án**: Chatible — Fullstack Web & Mobile App  
**Cơ sở Dữ liệu**: PostgreSQL 16 + Redis 7  
**Tài liệu tham chiếu**: `docs/dac-ta-nghiep-vu-v1.1.md` (Mục 15, 26)  

---

## 1. Sơ đồ Thực thể Quan hệ (Entity-Relationship Diagram)

```mermaid
erDiagram
    USERS ||--|| PROFILES : has
    USERS ||--o{ CHAT_SESSIONS : participates
    CHAT_SESSIONS ||--o{ MESSAGES : contains
    USERS ||--o{ FRIENDSHIPS : establishes
    USERS ||--o{ BLOCKED_USERS : blocks
    CHAT_SESSIONS ||--o{ REPORTS : reported_in
    REPORTS ||--o{ REPORT_EVIDENCE : freezes
    USERS ||--o{ AUDIT_LOGS : records

    USERS {
        uuid id PK
        string email UK "Private - not exposed"
        string password_hash "Argon2id"
        string google_sub "OAuth identifier"
        string status "PENDING_VERIF, ACTIVE, RESTRICTED, DELETED"
        timestamp email_verified_at
        timestamp created_at
        timestamp updated_at
    }

    PROFILES {
        uuid user_id PK, FK
        string nickname "Max 30 chars"
        string gender "MALE, FEMALE, OTHER"
        date birth_date "Private - used to calculate age"
        int calculated_age "Public - 18+"
        string preferred_gender "MALE, FEMALE, OTHER, ALL"
        int preferred_age_min "Default 18"
        int preferred_age_max "Default 30"
        boolean media_consent_default "Default false"
        timestamp updated_at
    }

    CHAT_SESSIONS {
        uuid id PK
        string session_type "RANDOM, FRIEND"
        uuid user_a_id FK
        uuid user_b_id FK
        string status "ACTIVE, RECONNECTING, ENDED"
        string end_reason "USER_LEFT, TIMEOUT, BLOCKED, REPORTED"
        timestamp started_at
        timestamp ended_at
        timestamp expires_at "ended_at + 7 days for RANDOM"
    }

    MESSAGES {
        uuid id PK
        uuid session_id FK
        uuid sender_id FK
        string message_type "TEXT, IMAGE, AUDIO, VIDEO"
        bytea encrypted_dek "Encrypted by KEK via Local KMS Provider (AES-KeyWrap)"
        bytea iv "AES-GCM Initialization Vector (12 bytes)"
        bytea auth_tag "AES-GCM Auth Tag (16 bytes)"
        bytea ciphertext "Encrypted message payload or S3 key"
        jsonb metadata "Waveform for audio, width/height for image"
        boolean is_adult_content "Default false"
        string watermark_token "Dynamic recipient trace token"
        boolean is_revoked_by_sender "Default false"
        timestamp accepted_at
        timestamp expires_at "accepted_at + 30 days for FRIEND, session expiry for RANDOM"
    }

    FRIENDSHIPS {
        uuid id PK
        uuid user_1_id FK
        uuid user_2_id FK
        string status "PENDING, ACCEPTED, DECLINED"
        timestamp established_at
        "UNIQUE (LEAST(user_1_id, user_2_id), GREATEST(user_1_id, user_2_id))"
    }

    BLOCKED_USERS {
        uuid id PK
        uuid blocker_id FK
        uuid blocked_id FK
        timestamp created_at
    }

    REPORTS {
        uuid id PK
        uuid session_id FK
        uuid reporter_id FK
        uuid reported_user_id FK
        string reason "UNDERAGE, HARASSMENT, NONCONSENSUAL_MEDIA, THREAT, SPAM, OTHER"
        text description
        string status "OPEN, IN_REVIEW, RESOLVED, DISMISSED"
        timestamp created_at
        timestamp closed_at
        timestamp expires_at "closed_at + 90 days"
    }

    REPORT_EVIDENCE {
        uuid id PK
        uuid report_id FK
        uuid message_id FK
        bytea frozen_encrypted_dek
        bytea frozen_ciphertext
        timestamp frozen_at
    }

    AUDIT_LOGS {
        uuid id PK
        uuid actor_id FK "Super Admin user_id"
        string action "OPEN_CHAT_TRANSCRIPT, OPEN_REPORT_EVIDENCE, REVOKE_USER"
        uuid target_resource_id "Session ID or Report ID"
        string ip_address
        timestamp timestamp
    }
```

---

## 2. Chi tiết Bảng & Ràng buộc PostgreSQL

### Bảng `users` & `profiles`
- Ràng buộc: `calculated_age >= 18` (bắt buộc theo Hiến pháp).
- Ràng buộc: `birth_date <= CURRENT_DATE - INTERVAL '18 years'`.
- Cột sinh tự động: `calculated_age INT GENERATED ALWAYS AS (DATE_PART('year', AGE(birth_date))) STORED;` (tránh sai lệch khi qua sinh nhật).
- Chỉ số (Indexes):
  - `idx_users_email` (UNIQUE, WHERE deleted_at IS NULL).
  - `idx_profiles_gender_age` (Hỗ trợ matching query).

### Bảng `messages` (Envelope Encryption Storage)
- **Cột bảo mật**:
  - `encrypted_dek`: Chứa DEK đã được Local KMS Provider bọc bằng Master KEK (AES-KeyWrap). Không thể đọc được nội dung nếu không có KEK.
  - `iv`: Vector khởi tạo 96-bit (12 bytes) ngẫu nhiên cho mỗi tin nhắn.
  - `auth_tag`: Thẻ xác thực toàn vẹn 128-bit (16 bytes).
  - `ciphertext`: Dữ liệu nội dung sau khi mã hóa bằng AES-256-GCM.
- **Chỉ số (Indexes)**:
  - `idx_messages_session_accepted` (`session_id`, `accepted_at`).
  - `idx_messages_expires_at` (`expires_at`) — Phục vụ cron job dọn dẹp tin nhắn hết hạn.

---

## 3. Cấu trúc Khóa Redis 7 (Matching Queue & Cache)

| Redis Key Pattern | Kiểu Dữ liệu | Mục đích sử dụng | TTL / Expiry |
|---|---|---|---|
| `match:queue:<target_gender>:<self_gender>` | **ZSET** | Hàng chờ ghép đôi. Member: `user_id`, Score: `timestamp` vào hàng. | Tự xóa khi match hoặc hủy |
| `match:user:<user_id>` | **HASH** | Lưu tiêu chí lọc: `age`, `age_min`, `age_max`, `socket_id`, `last_partner_id`. | 10 phút |
| `match:reserved:<user_id>` | **STRING** | Khóa tạm thời người dùng khi tìm thấy cặp hợp lệ (tránh 2 server cùng ghép). | 10 giây |
| `session:active:<user_id>` | **STRING** | Trạng thái phiên hiện tại của user (`IDLE`, `WAITING`, `CHATTING:session_id`). | Theo phiên |
| `session:reconnect:<session_id>` | **STRING** | Đếm ngược 30 giây khi 1 bên rớt mạng. | 30 giây |
| `token:media:<token_id>` | **STRING** | Token mờ hạn ngắn để xem ảnh/video người lớn (chứa `s3_key`). | 5 phút (300s) |

---

## 4. Máy trạng thái Vòng đời Chat (State Machine)

```mermaid
stateDiagram-v2
    [*] --> IDLE : Đăng nhập & Mở app

    IDLE --> WAITING : Bấm "Tìm bạn mới" (Tạo queue request)
    WAITING --> IDLE : Bấm "Hủy tìm kiếm"

    WAITING --> MATCHING : Thuật toán ghép tìm thấy đối tác phù hợp
    MATCHING --> CHATTING : 2 thiết bị xác nhận kết nối thành công (trong 1.2s)
    MATCHING --> WAITING : 1 bên rời hoặc hủy trước khi sẵn sàng

    CHATTING --> RECONNECTING : 1 bên mất mạng đột ngột (Socket ngắt)
    RECONNECTING --> CHATTING : Kết nối lại thành công trong vòng 30s
    RECONNECTING --> ENDED : Hết hạn 30s hoặc bên còn lại bấm Kết thúc

    CHATTING --> ENDED : Bấm "Chuyển người", "Kết thúc" hoặc "Chặn"

    ENDED --> WAITING : Bấm "Tìm người mới" trên thanh hành động
    ENDED --> IDLE : Bấm "Dừng" hoặc chuyển màn hình khác
```
