# Chatible Project Constitution
<!-- Invariants, Core Principles, and Architectural Safeguards for Chatible Web App -->

## Core Principles

### I. Độ tuổi 18+ & Riêng tư Danh tính (NON-NEGOTIABLE)
- **Ràng buộc 18+:** Nền tảng chỉ phục vụ người dùng từ 18 tuổi trở lên. Ngày sinh riêng tư được thu thập lúc tạo tài khoản (Email hoặc Google OAuth); máy chủ tính toán tuổi và từ chối ngay lập tức nếu khai dưới 18 tuổi hoặc ngày sinh trong tương lai.
- **Tuổi tự khai:** Tuổi là thông tin tự khai, không yêu cầu xác minh CCCD/giấy tờ hay dịch vụ xác minh bên thứ ba trong bản đầu.
- **Cô lập Thông tin Riêng tư:** Trong mọi tương tác (chat ngẫu nhiên và bạn bè), đối phương chỉ nhìn thấy: `Biệt danh` + `Giới tính tự khai` + `Số tuổi tính toán`. Tuyệt đối không trả về qua API, WebSocket event hoặc giao diện: `email`, `ngày sinh`, `địa chỉ IP`, `user_id` nội bộ, hay danh sách chặn.

### II. Mã hóa Envelope & An toàn Khóa KMS (NON-NEGOTIABLE)
- **Cơ chế Mã hóa:** Áp dụng mã hóa tầng ứng dụng Envelope Encryption cho toàn bộ nội dung tin nhắn, tệp media, ảnh xem trước và bằng chứng báo cáo. Mỗi đối tượng dữ liệu được mã hóa bằng một Data Encryption Key (DEK) riêng biệt; DEK được bọc bởi Key Encryption Key (KEK) lưu trữ tại Cloud KMS được quản lý (Customer-Managed Key).
- **Cấm Lưu Trữ Plaintext & Rò rỉ Log:** Tuyệt đối không lưu DEK rõ, KEK, mật khẩu, token truy cập hoặc plaintext của tin nhắn/media trong cơ sở dữ liệu, mã nguồn, git repository hoặc nhật ký kỹ thuật (error logs, access logs, debug traces).
- **Cam kết Minh bạch:** Sản phẩm không phải là mã hóa đầu cuối (E2EE) giữa hai thiết bị người dùng. Không được tuyên bố vô danh với đơn vị vận hành hoặc sử dụng thuật ngữ E2EE trên giao diện/chính sách.

### III. Quản trị viên Tối cao Duy nhất & Kiểm toán Minh bạch
- **Vai trò Bất biến:** Trong toàn bộ vòng đời hệ thống chỉ có duy nhất một tài khoản cố định giữ vai trò Quản trị viên tối cao (Super Admin); không chuyển quyền, không tạo tài khoản quản trị phụ hoạt động đồng thời.
- **Toàn quyền Phân xử:** Quản trị viên tối cao có quyền giải mã và xem đầy đủ mọi cuộc chat và media còn hạn lưu trữ (kể cả media đã bị người gửi thu hồi) khi thật sự cần thiết để phân xử tranh chấp hoặc xử lý vi phạm.
- **Tự động Ghi AuditLog:** Mỗi thao tác mở xem nội dung chat/media của Quản trị viên tối cao bắt buộc tự động sinh bản ghi `AuditLog` và `KeyAccessAudit` (ghi nhận người truy cập, vai trò, thời điểm, tài nguyên đã mở). AuditLog không chứa nội dung tin nhắn, DEK hoặc token.

### IV. Vòng đời Lưu trữ & Bảo toàn Bằng chứng (Strict Retention)
- **Chat Ngẫu nhiên (Random Chat):** Tin nhắn và media thường được lưu trữ và cho phép xem lại, chặn, báo cáo trong vòng tối đa **7 ngày** kể từ thời điểm phiên chat kết thúc (`ended_at + 7 days`). Hết hạn, cron worker tự động dọn dẹp triệt để.
- **Chat Bạn bè (Friend Chat):** Từng tin nhắn và media tự động xóa cuốn chiếu sau **30 ngày** kể từ lúc máy chủ tiếp nhận (`accepted_at + 30 days`), bất kể người nhận đã đọc hay chưa.
- **Bằng chứng Báo cáo:** Bằng chứng vi phạm được tiếp nhận hợp lệ tách khỏi luồng dọn tin thông thường; được bảo toàn trong suốt thời gian xử lý và đúng **90 ngày** sau khi hồ sơ báo cáo được đóng (`closed_at + 90 days`).
- **AuditLog:** Lưu trữ nhật ký kiểm toán trong 180 ngày; bản sao lưu mã hóa database lưu tối đa 35 ngày.

### V. Kiểm soát Media, Watermark Động & Hạn chế Lưu
- **Giới hạn Kích thước & Nén Client-Side:** Trình duyệt người dùng tự động resize và nén ảnh (về chuẩn WebP/JPEG chất lượng cao, dung lượng ~300KB–800KB) trước khi gửi để giải phóng tải CPU máy chủ và tăng tốc độ mạng di động. Máy chủ kiểm tra kích thước thực tế $(<30$ MB ảnh, $<100$ MB video) và xác thực magic bytes trước khi mã hóa.
- **Quyền Nhận Media:** Trong chat người lạ, người nhận phải chủ động bật nhận media mới được gửi; bạn bè được gửi mặc định.
- **Nội dung Người lớn (Adult/Sensitive Content):** 
  - Chỉ cho phép giữa người lớn có đồng thuận khi người gửi chủ động bấm nút "Nội dung người lớn" và xác nhận cam kết 18+.
  - Watermark theo người nhận là bắt buộc mặc định trên mọi ảnh/video nhạy cảm (chứa safe label + trace code mờ ánh xạ máy chủ; không lộ email/user_id).
  - Áp dụng chế độ hạn chế lưu: Không link tải, không URL tệp công khai/cố định. Xem qua khóa token mờ hạn ngắn (5 phút).
  - Người gửi có quyền chủ động thu hồi quyền xem media của chính mình.
  - Giao diện và thông tin riêng tư phải nêu rõ giới hạn kỹ thuật: Web không thể ngăn chặn tuyệt đối việc quay màn hình hoặc chụp ảnh bằng thiết bị ngoài.

### VI. Kiến trúc Mobile-First & Ghép đôi Trung thực
- **Mobile-First UX:** Giao diện tối ưu hóa cho màn hình điện thoại, tương thích bàn phím ảo (không che ô nhập), hỗ trợ bộ gõ tiếng Việt (Telex/VNI - không gửi khi đang gõ dở ký tự), hỗ trợ Safe Area và Accessibility.
- **Khung Chat Đơn (Single Dynamic Container):** Chat ngẫu nhiên diễn ra trên 1 màn hình duy nhất, chuyển đổi linh hoạt qua 6 trạng thái: `IDLE`, `WAITING`, `MATCHING`, `CHATTING`, `RECONNECTING`, `ENDED`.
- **Ghép đôi Hai chiều:** Phải thỏa mãn đồng thời giới tính và khoảng tuổi của cả 2 bên. Không tự ý nới lỏng bộ lọc nếu người dùng chưa bấm đồng ý.
- **Cấm Tuyệt đối Bot Giả:** Không dùng bot giả làm người thật, không hiển thị số lượng người online giả mạo.

---

## Ràng buộc Kỹ thuật & Hạ tầng (Deployment & Tech Stack)

- **Backend:** Laravel 11 API, PostgreSQL (cơ sở dữ liệu chính), Redis (quản lý hàng chờ matching và caching), Laravel Reverb (WebSocket server realtime), Queue Worker.
- **Mã hóa:** Tích hợp Customer-Managed KMS Key (AWS KMS / GCP Cloud KMS / Vault). Object Storage (S3-compatible) lưu trữ ciphertext của media.
- **Chiến lược Triển khai (DEPLOY-01, DEPLOY-02):** Khởi đầu bằng 1 Node duy nhất chạy toàn bộ dịch vụ backend, tách biệt hoàn toàn Cloud KMS và Object Storage độc lập. Khi chịu tải lớn, tách theo thứ tự: Queue Worker Media -> PostgreSQL -> Redis -> Reverb WebSocket -> Laravel API.

---

## Tiêu chuẩn Nghiệm thu & Hội tụ (Quality Gates & Convergence)

- **103 Ca Nghiệm thu Bắt buộc (T01 – T103):** Một module/tính năng chỉ được coi là `Converged` khi toàn bộ các ca kiểm thử liên quan trong tài liệu đặc tả `docs/dac-ta-nghiep-vu-v1.1.md` đã được kiểm tra và vượt qua (pass) với bằng chứng thực tế.
- **Phân định Rõ [CHỐT] và [ĐỀ XUẤT]:** Không tự ý biến các đề xuất kỹ thuật thành yêu cầu đã duyệt nếu chưa có xác nhận từ Chủ sản phẩm.
- **TDD & Contract Testing:** Bắt buộc viết test case cho các điều kiện biên: ghép đôi đồng thời, hủy ghép cạnh tranh, mất mạng 30s, gửi tin lặp idempotency, thu hồi media cạnh tranh với lượt xem.

---

## Governance & Amendments

- Bản Hiến pháp này là kim chỉ nam tối cao cho toàn bộ quá trình Spec-Driven Development của dự án Chatible.
- Mọi điều chỉnh liên quan đến chính sách tuổi, mã hóa, lưu trữ dữ liệu và quyền hạn của Quản trị viên tối cao bắt buộc phải có sự phê duyệt chính thức bằng văn bản của Chủ sản phẩm.

**Version**: 1.2.0 | **Ratified**: 2026-11-07 | **Last Amended**: 2026-11-08 | **Source**: `docs/dac-ta-nghiep-vu-v1.1.md`
