/**
 * Abstract KMS Provider Interface for Envelope Encryption
 * Swappable between LocalKmsProvider ($0) and Cloud KMS (AWS/GCP)
 */
export interface IKmsProvider {
  /**
   * Wrap a Data Encryption Key (DEK) with the Master Key Encryption Key (KEK)
   * @param plaintextDek Raw 32-byte AES key
   * @returns Wrapped DEK
   */
  wrapKey(plaintextDek: Uint8Array): Promise<Uint8Array>;

  /**
   * Unwrap an encrypted DEK using the Master KEK
   * @param encryptedDek Wrapped DEK bytes
   * @returns Raw 32-byte AES key
   */
  unwrapKey(encryptedDek: Uint8Array): Promise<Uint8Array>;
}
