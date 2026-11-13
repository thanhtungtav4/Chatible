CREATE INDEX IF NOT EXISTS "idx_messages_session_accepted_id"
  ON "messages" ("session_id", "accepted_at", "id");
