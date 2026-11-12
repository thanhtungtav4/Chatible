ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'READY' NOT NULL;
--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "status" SET DEFAULT 'PENDING_UPLOAD';
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "verified_mime" varchar(100);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "finalized_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "sender_confirmed_18_plus" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "sender_confirmed_consent" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "adult_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL REFERENCES "public"."chat_sessions"("id") ON DELETE cascade,
	"recipient_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"enabled" boolean DEFAULT false NOT NULL,
	"policy_acknowledged_at" timestamp with time zone,
	"granted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_adult_consent_session_recipient" ON "adult_consents" USING btree ("session_id", "recipient_id");
--> statement-breakpoint
ALTER TABLE "media_view_tokens" ADD COLUMN IF NOT EXISTS "trace_code" varchar(32);
--> statement-breakpoint
ALTER TABLE "media_view_tokens" ADD COLUMN IF NOT EXISTS "watermark_text" varchar(160);
--> statement-breakpoint
ALTER TABLE "media_view_tokens" ADD COLUMN IF NOT EXISTS "stream_key_wrapped" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "client_message_id" varchar(64);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_messages_client_idempotency" ON "messages" USING btree ("session_id", "sender_id", "client_message_id") WHERE "client_message_id" IS NOT NULL;
