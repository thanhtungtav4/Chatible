import dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: '../.env' });

export type KmsProviderType = 'local' | 'aws-kms';

const isPlaceholder = (value: string): boolean => /replace_with|your_|changeme|placeholder/i.test(value);

export function buildValidatedConfig(env: NodeJS.ProcessEnv = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  const providedJwtSecret = env.JWT_SECRET;
  const providedAdminJwtSecret = env.ADMIN_JWT_SECRET;
  const providedMasterKek = env.APP_MASTER_KEK;
  const adminSecret = env.ADMIN_SECRET_TOKEN || '';
  const adminTotpSecret = env.ADMIN_TOTP_SECRET?.trim() || '';
  const adminUsername = env.ADMIN_USERNAME?.trim() || 'admin';
  const adminPassword = env.ADMIN_PASSWORD?.trim() || '';
  const adminGoogleEmail = env.ADMIN_GOOGLE_EMAIL?.trim().toLowerCase() || 'nguyenthanhtung74119@gmail.com';
  const providedDatabaseUrl = env.DATABASE_URL;

  const kmsProviderRaw = (env.KMS_PROVIDER?.trim().toLowerCase() || (isProduction ? 'aws-kms' : 'local')) as KmsProviderType;
  if (!['local', 'aws-kms'].includes(kmsProviderRaw)) {
    throw new Error('FATAL: KMS_PROVIDER must be either "local" or "aws-kms".');
  }
  const awsKms = {
    keyId: env.AWS_KMS_KEY_ID?.trim() || '',
    region: env.AWS_KMS_REGION?.trim() || env.AWS_REGION?.trim() || 'ap-southeast-1',
    endpoint: env.AWS_KMS_ENDPOINT?.trim() || '',
  };

  const objectStorage = {
    endpoint: env.S3_ENDPOINT?.trim() || '',
    bucket: env.S3_BUCKET?.trim() || '',
    accessKeyId: env.S3_ACCESS_KEY_ID?.trim() || '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY?.trim() || '',
    region: env.S3_REGION?.trim() || 'auto',
    forcePathStyle: env.S3_FORCE_PATH_STYLE?.trim() || '',
  };
  const hasSomeStorageConfig = [
    objectStorage.endpoint,
    objectStorage.bucket,
    objectStorage.accessKeyId,
    objectStorage.secretAccessKey,
  ].some(Boolean);
  const hasCompleteStorageConfig = [
    objectStorage.endpoint,
    objectStorage.bucket,
    objectStorage.accessKeyId,
    objectStorage.secretAccessKey,
  ].every(Boolean);

  if (objectStorage.forcePathStyle && !['true', 'false'].includes(objectStorage.forcePathStyle)) {
    throw new Error('FATAL: S3_FORCE_PATH_STYLE must be either true or false.');
  }
  if (hasSomeStorageConfig && !hasCompleteStorageConfig) {
    throw new Error('FATAL: Configure S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY together.');
  }
  if (hasCompleteStorageConfig) {
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(objectStorage.endpoint);
      if (!['http:', 'https:'].includes(parsedEndpoint.protocol) || isPlaceholder(objectStorage.endpoint)) {
        throw new Error();
      }
    } catch {
      throw new Error('FATAL: S3_ENDPOINT must be a valid non-placeholder HTTP(S) URL.');
    }
    if (isProduction && parsedEndpoint.protocol !== 'https:') {
      throw new Error('FATAL: S3_ENDPOINT must use HTTPS in production.');
    }
    if ([objectStorage.bucket, objectStorage.accessKeyId, objectStorage.secretAccessKey].some(isPlaceholder)) {
      throw new Error('FATAL: S3_BUCKET and S3 credentials must not be placeholders.');
    }
  }
  if (isProduction && !hasCompleteStorageConfig) {
    if (env.ALLOW_MOCK_STORAGE_IN_PRODUCTION !== 'true') {
      throw new Error('FATAL: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY are required in production.');
    }
  }
  if (providedJwtSecret && (Buffer.byteLength(providedJwtSecret, 'utf8') < 32 || isPlaceholder(providedJwtSecret))) {
    throw new Error('FATAL: JWT_SECRET must be a non-placeholder secret with at least 32 bytes.');
  }
  if (providedAdminJwtSecret && (Buffer.byteLength(providedAdminJwtSecret, 'utf8') < 32 || isPlaceholder(providedAdminJwtSecret))) {
    throw new Error('FATAL: ADMIN_JWT_SECRET must be a non-placeholder secret with at least 32 bytes.');
  }
  if (adminSecret && (Buffer.byteLength(adminSecret, 'utf8') < 32 || isPlaceholder(adminSecret))) {
    throw new Error('FATAL: ADMIN_SECRET_TOKEN must be a non-placeholder secret with at least 32 bytes.');
  }
  if (isProduction) {
    if (!providedDatabaseUrl) {
      throw new Error('FATAL: DATABASE_URL must be explicitly configured in production.');
    }
    if (!providedJwtSecret) {
      throw new Error('FATAL: JWT_SECRET must be explicitly configured with at least 32 bytes in production.');
    }
    if (kmsProviderRaw === 'aws-kms') {
      if (!awsKms.keyId || isPlaceholder(awsKms.keyId)) {
        throw new Error('FATAL: AWS_KMS_KEY_ID is required when KMS_PROVIDER=aws-kms in production.');
      }
    } else {
      if (env.ALLOW_INSECURE_LOCAL_KMS_IN_PRODUCTION !== 'true') {
        throw new Error(
          'FATAL: KMS_PROVIDER=aws-kms is required in production (customer-managed KMS). Set ALLOW_INSECURE_LOCAL_KMS_IN_PRODUCTION=true only for isolated staging.'
        );
      }
      if (!providedMasterKek || !/^[0-9a-f]{64}$/i.test(providedMasterKek)) {
        throw new Error('FATAL: APP_MASTER_KEK must be explicitly configured as 64 hex characters when local KMS override is enabled.');
      }
    }
    if (!adminSecret) {
      throw new Error('FATAL: ADMIN_SECRET_TOKEN is required in production.');
    }
    if (!adminTotpSecret || !/^[A-Z2-7]+=*$/i.test(adminTotpSecret) || adminTotpSecret.length < 16 || isPlaceholder(adminTotpSecret)) {
      throw new Error('FATAL: ADMIN_TOTP_SECRET (valid Base32 >= 16 chars) is required in production.');
    }
  }

  const superAdminId = env.SUPER_ADMIN_ID || '00000000-0000-0000-0000-000000000001';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(superAdminId)) {
    throw new Error('FATAL: SUPER_ADMIN_ID must be a UUID.');
  }

  const defaultCorsOrigins = ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];
  const corsOrigins = (env.CORS_ORIGIN || env.FRONTEND_URL)
    ? (env.CORS_ORIGIN || env.FRONTEND_URL)!
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : defaultCorsOrigins;

  return {
    nodeEnv,
    port: parseInt(env.PORT || '3000', 10),
    host: env.HOST || '0.0.0.0',
    databaseUrl: providedDatabaseUrl || 'postgresql://macbook@localhost:5432/chatible_db',
    redisUrl: env.REDIS_URL || 'redis://localhost:6379',
    jwtSecret: providedJwtSecret || 'dev_secret_jwt_chatible_min_32_bytes_super_secure',
    adminJwtSecret:
      providedAdminJwtSecret ||
      `${providedJwtSecret || 'dev_secret_jwt_chatible_min_32_bytes_super_secure'}_admin_isolated_key_32_bytes`,
    corsOrigins,
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    kmsProvider: kmsProviderRaw,
    awsKms,
    masterKek: providedMasterKek || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    adminSecret,
    adminTotpSecret,
    adminUsername,
    adminPassword,
    adminGoogleEmail,
    objectStorage: {
      endpoint: objectStorage.endpoint,
      bucket: objectStorage.bucket,
      accessKeyId: objectStorage.accessKeyId,
      secretAccessKey: objectStorage.secretAccessKey,
      region: objectStorage.region,
      forcePathStyle: objectStorage.forcePathStyle === 'true',
    },
    superAdminId,
  };
}

export const config = buildValidatedConfig(process.env);
