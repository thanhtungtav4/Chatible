-- Production Least-Privilege Database Role Hardening Script for Chatible
-- Run as PostgreSQL superuser during infrastructure provisioning.
-- Separates migration/schema-owner privileges from runtime application credentials.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'chatible_app') THEN
    CREATE ROLE chatible_app WITH LOGIN PASSWORD 'CHANGE_ME_STRONG_APP_DB_PASSWORD';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE chatible_db TO chatible_app;
GRANT USAGE ON SCHEMA public TO chatible_app;

-- Standard runtime tables: SELECT, INSERT, UPDATE, DELETE (never DDL/TRUNCATE)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chatible_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO chatible_app;

-- Audit Logs table: STRICTLY APPEND-ONLY (SELECT + INSERT only; revoke UPDATE/DELETE/TRUNCATE)
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM chatible_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM PUBLIC;

-- Note: For WORM log shipping, pair GET /api/v1/admin/audit-logs/export with an S3 Bucket
-- configured with S3 Object Lock (COMPLIANCE mode) and cross-account replication.
