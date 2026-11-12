CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"media_type" varchar(20) NOT NULL,
	"content_type" varchar(255) NOT NULL,
	"file_size" integer NOT NULL,
	"encrypted_dek" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"is_adult" boolean DEFAULT false NOT NULL,
	"watermark_token" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "media_assets_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "media_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"granted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_view_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "media_view_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "expires_at" DROP NOT NULL;
--> statement-breakpoint
UPDATE "reports"
SET "expires_at" = NULL
WHERE "status" NOT IN ('RESOLVED', 'DISMISSED') OR "closed_at" IS NULL;
--> statement-breakpoint
UPDATE "reports"
SET "expires_at" = "closed_at" + INTERVAL '90 days'
WHERE "status" IN ('RESOLVED', 'DISMISSED') AND "closed_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_consents" ADD CONSTRAINT "media_consents_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_consents" ADD CONSTRAINT "media_consents_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_view_tokens" ADD CONSTRAINT "media_view_tokens_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_view_tokens" ADD CONSTRAINT "media_view_tokens_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_media_assets_session" ON "media_assets" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_media_assets_recipient" ON "media_assets" USING btree ("recipient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_media_consent_session_recipient" ON "media_consents" USING btree ("session_id","recipient_id");--> statement-breakpoint
CREATE INDEX "idx_media_view_tokens_media" ON "media_view_tokens" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "idx_media_view_tokens_expiry" ON "media_view_tokens" USING btree ("expires_at");