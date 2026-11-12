CREATE TABLE IF NOT EXISTS "community_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" varchar(255),
	"type" varchar(24) NOT NULL,
	"passcode_hash" varchar(255),
	"created_by" uuid NOT NULL REFERENCES "public"."users"("id"),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "community_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL REFERENCES "public"."community_rooms"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"role" varchar(20) DEFAULT 'MEMBER' NOT NULL,
	"passcode_verified_at" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_community_member_room_user" ON "community_members" USING btree ("room_id", "user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "community_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL REFERENCES "public"."community_rooms"("id") ON DELETE cascade,
	"sender_id" uuid NOT NULL REFERENCES "public"."users"("id"),
	"message_type" varchar(20) DEFAULT 'TEXT' NOT NULL,
	"encrypted_dek" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"ciphertext" text NOT NULL,
	"metadata" jsonb,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_community_messages_room" ON "community_messages" USING btree ("room_id", "accepted_at");
