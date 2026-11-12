ALTER TABLE "report_evidence" ADD COLUMN IF NOT EXISTS "iv" text;
--> statement-breakpoint
ALTER TABLE "report_evidence" ADD COLUMN IF NOT EXISTS "auth_tag" text;
--> statement-breakpoint
ALTER TABLE "report_evidence" ADD COLUMN IF NOT EXISTS "message_type" varchar(20);
--> statement-breakpoint
UPDATE "report_evidence" AS evidence
SET
  "iv" = COALESCE(evidence."iv", messages."iv"),
  "auth_tag" = COALESCE(evidence."auth_tag", messages."auth_tag"),
  "message_type" = COALESCE(evidence."message_type", messages."message_type", 'TEXT')
FROM "messages"
WHERE evidence."message_id" = messages."id"
  AND (evidence."iv" IS NULL OR evidence."auth_tag" IS NULL OR evidence."message_type" IS NULL);
--> statement-breakpoint
UPDATE "report_evidence" SET "message_type" = 'TEXT' WHERE "message_type" IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "report_evidence" WHERE "iv" IS NULL OR "auth_tag" IS NULL) THEN
    RAISE EXCEPTION 'Cannot migrate report_evidence: IV or auth tag cannot be recovered from source messages.';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "report_evidence" ALTER COLUMN "iv" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "report_evidence" ALTER COLUMN "auth_tag" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "report_evidence" ALTER COLUMN "message_type" SET DEFAULT 'TEXT';
--> statement-breakpoint
ALTER TABLE "report_evidence" ALTER COLUMN "message_type" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "report_evidence" DROP CONSTRAINT IF EXISTS "report_evidence_message_id_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT IF EXISTS "reports_session_id_chat_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "session_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
