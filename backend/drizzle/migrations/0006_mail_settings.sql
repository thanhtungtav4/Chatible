INSERT INTO "system_settings" ("key", "value", "description", "category")
VALUES
  ('mail.smtp.enabled', 'false', 'Bật / tắt gửi email tự động qua SMTP', 'MAIL'),
  ('mail.smtp.host', '', 'Máy chủ SMTP (vd: smtp.gmail.com, smtp.resend.com)', 'MAIL'),
  ('mail.smtp.port', '587', 'Cổng kết nối SMTP (587 cho STARTTLS, 465 cho SSL)', 'MAIL'),
  ('mail.smtp.secure', 'false', 'Sử dụng kết nối bảo mật SSL/TLS trực tiếp (Port 465)', 'MAIL'),
  ('mail.smtp.user', '', 'Tài khoản / Email đăng nhập SMTP', 'MAIL'),
  ('mail.smtp.password', '', 'Mật khẩu ứng dụng hoặc API Key SMTP (được mã hóa KMS)', 'MAIL'),
  ('mail.smtp.from_name', 'Chatible Support', 'Tên người gửi hiển thị trong hộp thư', 'MAIL'),
  ('mail.smtp.from_address', 'no-reply@chatible.app', 'Địa chỉ email người gửi', 'MAIL')
ON CONFLICT ("key") DO NOTHING;
