CREATE TABLE IF NOT EXISTS "system_settings" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"description" varchar(255),
	"category" varchar(50) DEFAULT 'GENERAL' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

INSERT INTO "system_settings" ("key", "value", "description", "category")
VALUES
  ('auth.google.enabled', 'true', 'Bật / tắt chức năng đăng nhập bằng tài khoản Google', 'AUTH'),
  ('auth.google.client_id', '', 'Google OAuth 2.0 Web Client ID', 'AUTH'),
  ('auth.registration.enabled', 'true', 'Cho phép người dùng mới đăng ký tài khoản', 'AUTH'),
  ('retention.random_chat_days', '7', 'Thời gian lưu trữ tin nhắn chat ngẫu nhiên (ngày)', 'RETENTION'),
  ('retention.friend_chat_days', '30', 'Thời gian lưu trữ tin nhắn bạn bè (ngày)', 'RETENTION'),
  ('retention.report_evidence_days', '90', 'Thời gian lưu trữ bằng chứng sau khi đóng hồ sơ báo cáo (ngày)', 'RETENTION')
ON CONFLICT ("key") DO NOTHING;
