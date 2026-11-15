CREATE INDEX IF NOT EXISTS "idx_chat_sessions_user_a_status" ON "chat_sessions" ("user_a_id", "status");
CREATE INDEX IF NOT EXISTS "idx_chat_sessions_user_b_status" ON "chat_sessions" ("user_b_id", "status");
CREATE INDEX IF NOT EXISTS "idx_chat_sessions_expires_at" ON "chat_sessions" ("expires_at");
CREATE INDEX IF NOT EXISTS "idx_friend_requests_to_status" ON "friend_requests" ("to_user_id", "status");
CREATE INDEX IF NOT EXISTS "idx_friend_requests_from_status" ON "friend_requests" ("from_user_id", "status");
CREATE INDEX IF NOT EXISTS "idx_messages_expires_at" ON "messages" ("expires_at");
CREATE INDEX IF NOT EXISTS "idx_messages_client_idempotency" ON "messages" ("session_id", "sender_id", "client_message_id");
CREATE INDEX IF NOT EXISTS "idx_community_messages_expires_at" ON "community_messages" ("expires_at");
