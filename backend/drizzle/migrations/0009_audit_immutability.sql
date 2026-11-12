ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "prev_hash" varchar(64);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "entry_hash" varchar(64);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "details" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_logs_seq" ON "audit_logs" USING btree ("seq");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only; UPDATE and DELETE operations are forbidden.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON "audit_logs";
--> statement-breakpoint
CREATE TRIGGER trg_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_mutation();
--> statement-breakpoint
INSERT INTO "system_settings" ("key", "value", "description", "category")
VALUES
  ('admin.mfa.enabled', 'false', 'Bắt buộc xác thực 2 bước (TOTP) khi đăng nhập Super Admin', 'SECURITY'),
  ('admin.mfa.totp_secret', '', 'Khóa bí mật TOTP của Super Admin (được mã hóa KMS)', 'SECURITY')
ON CONFLICT ("key") DO NOTHING;
