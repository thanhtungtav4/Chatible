# PM release gate — Chatible

Ngày rà soát: 12/11/2026. Tài liệu này phân biệt rõ **đã chạy kiểm thử** với **đủ điều kiện phát hành**.

## Hoàn thành trong vòng rà soát này

- Stealth Vault không còn PIN mặc định hoặc lưu PIN rõ trong `localStorage`. PIN 4 số do người dùng tạo được băm bằng scrypt phía máy chủ; đổi PIN đòi PIN hiện tại; thử mở khóa bị giới hạn 5 lần/phút.
- Màn hình phiên gần đây không gọi API tải lịch sử trước khi Kho riêng tư được mở khóa.
- Giới hạn upload được tách theo nghiệp vụ: ảnh `< 30.000.000` byte, video `< 100.000.000` byte, ghi âm `< 20.000.000` byte; loại media phải khớp `Content-Type` khai báo.
- Migration `0007_stealth_vault` đã được áp dụng. Toàn bộ 51 test, typecheck, lint và build đều qua.

## Không được gọi là sẵn sàng production trước khi đóng P0

| Mức | Việc cần làm | Lý do / tiêu chí nghiệm thu |
|---|---|---|
| P0 | Thay `LocalKmsService` bằng customer-managed KMS cloud | Đặc tả D30 đã chốt customer-managed KMS, nhưng code hiện dùng `APP_MASTER_KEK` trong biến môi trường. Chốt nhà cung cấp và vùng dữ liệu; ứng dụng chỉ có danh tính dịch vụ quyền tối thiểu; không có KEK rõ trong app/node; kiểm tra xoay khóa và khôi phục backup. |
| P0 | Hoàn tất upload media trước khi phát tin nhắn | URL PUT ký sẵn hiện nhận kích thước/loại tệp do client khai báo. Thêm `POST /media/:id/complete`: HEAD object để xác nhận số byte thực tế, giải mã server-side trong bộ nhớ bằng DEK đã bọc để kiểm tra magic bytes/loại tệp, rồi mới cho Socket Gateway công bố tin nhắn. Tệp sai hoặc quá giới hạn phải bị xóa, không hiện trong chat. |
| P0 | Bỏ JWT khỏi `localStorage` | XSS có thể lấy token hiện tại. Dùng cookie `HttpOnly`, `Secure`, `SameSite` phù hợp; thêm bảo vệ CSRF/origin cho yêu cầu ghi và xác thực Socket.IO bằng cookie/token ngắn hạn. |
| P0 | Chuyển rate limit nhạy cảm sang Redis | `MemoryRateLimiter` chỉ hiệu lực từng process; khi scale nhiều node hoặc restart sẽ mất giới hạn. Áp dụng chung cho login, reset mật khẩu, PIN vault, upload, cấp view token và báo cáo. |
| P0 | Phê duyệt chính sách người lớn và quy trình vận hành | Tính năng sensitive media không nên public khi chưa có SLA báo cáo, luồng hạn chế tạm thời, khiếu nại, xử lý nghi có người dưới tuổi/không đồng thuận, và kịch bản khẩn cấp. Việc tự khai 18+ không chứng minh tuổi hay đồng thuận. |

## P1 — làm ngay sau P0

- Kiểm thử E2E thật cho: đăng ký → chat → consent media → upload/hoàn tất → xem watermark → thu hồi → báo cáo → Admin audit log.
- Không cho SVG/định dạng không cần thiết trong ảnh; danh sách MIME cho phép rõ ràng (JPEG, PNG, WebP; MP4/WebM; M4A/MP3/WebM) thay vì cho mọi `image/*`, `audio/*`, `video/*`.
- Thêm quét malware/abuse và giới hạn tần suất/số tệp theo tài khoản trước khi media được phát hành.
- Xác nhận quyền Super Admin cố định: MFA bắt buộc, secret không dùng chung, audit log chỉ append, cảnh báo khi mở nội dung hoặc gọi KMS bất thường.
- Thêm quan sát vận hành: health checks, metric hàng đợi ghép đôi/WebSocket, lỗi upload/cleanup, backup restore drill và cảnh báo hết dung lượng.

## P2 — hoàn thiện sản phẩm sau khi nền tảng an toàn

- Nhóm/kênh ở D32 chưa thấy module nghiệp vụ tương ứng; tách thành epic riêng, không gộp vào chat 1-1 hiện tại.
- Thông báo chưa đọc/push, trạng thái giao-đọc, thông báo khi lời mời kết bạn hoặc báo cáo được xử lý.
- Hỗ trợ accessibility và kiểm thử thiết bị di động thật cho recorder, upload video, khóa màn hình và mạng chập chờn.

## Quyết định cần chủ sản phẩm chốt trước P0.1

1. Cloud nào và vùng dữ liệu production cho KMS/object storage (AWS, Cloudflare R2 + KMS phù hợp, hoặc nhà cung cấp khác)?
2. Kích hoạt sensitive media khi nào: chỉ sau khi có SLA/quy trình ở trên, hay tắt hoàn toàn ở đợt phát hành đầu?
3. Cookie dùng cùng domain hay frontend/backend là hai subdomain? Quyết định này quyết định cấu hình `SameSite`, CORS và CSRF.
