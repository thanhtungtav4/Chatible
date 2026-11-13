CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "email" varchar(255) NOT NULL,
  "code_hash" varchar(128) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_email_verif_user_created" ON "email_verification_tokens" ("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "user_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "type" varchar(50) NOT NULL,
  "title" varchar(160) NOT NULL,
  "body" text NOT NULL,
  "related_resource_id" uuid,
  "is_read" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_user_notifications_user_created" ON "user_notifications" ("user_id", "created_at");

INSERT INTO "system_settings" ("key", "value", "category", "description")
VALUES (
  'auth.email_verification.required',
  'false',
  'AUTH',
  'Bắt buộc xác minh email trước khi tìm bạn/nhắn tin ngẫu nhiên'
)
ON CONFLICT ("key") DO NOTHING;
