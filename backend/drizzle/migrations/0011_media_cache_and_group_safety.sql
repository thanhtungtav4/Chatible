CREATE TABLE IF NOT EXISTS "media_watermarked_variants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "media_id" uuid NOT NULL REFERENCES "media_assets"("id") ON DELETE cascade,
  "recipient_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "object_key" text NOT NULL,
  "encrypted_dek" text NOT NULL,
  "iv" text NOT NULL,
  "auth_tag" text NOT NULL,
  "content_type" varchar(100) NOT NULL,
  "file_size" integer NOT NULL,
  "trace_code" varchar(32) NOT NULL,
  "watermark_text" varchar(160) NOT NULL,
  "status" varchar(20) DEFAULT 'PENDING' NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_media_wm_variant_unique" ON "media_watermarked_variants" USING btree ("media_id", "recipient_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_media_wm_variant_expiry" ON "media_watermarked_variants" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "community_messages" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "community_messages" ADD COLUMN IF NOT EXISTS "deleted_by" uuid REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "room_id" uuid REFERENCES "community_rooms"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "report_evidence" ADD COLUMN IF NOT EXISTS "group_message_id" uuid;
