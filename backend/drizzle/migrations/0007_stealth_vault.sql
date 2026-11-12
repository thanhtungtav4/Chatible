ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "stealth_enabled" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "stealth_pin_hash" varchar(255);
