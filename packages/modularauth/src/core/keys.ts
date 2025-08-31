/**
 * Key management module
 * Based on OpenAuth's packages/openauth/src/keys.ts
 * 
 * This module handles:
 * - Generating signing keys (ES256 for better performance)
 * - Storing keys in storage with proper serialization
 * - Automatic key generation when no valid keys exist
 * - Key rotation support (to be implemented)
 */

import {
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  JWK,
  KeyLike,
} from "jose"
import { Storage } from "../storage/index.js"
import type { StorageAdapter } from "./types.js"

// Using ES256 (ECDSA) instead of RS256 for better performance
// OpenAuth also uses ES256 as the default
const signingAlg = "ES256"

/**
 * Serialized format for storing keys
 * From OpenAuth: packages/openauth/src/keys.ts lines 16-23
 */
interface SerializedKeyPair {
  id: string
  publicKey: string
  privateKey: string
  created: number
  alg: string
  expired?: number
}

/**
 * Runtime key pair with loaded crypto keys
 * From OpenAuth: packages/openauth/src/keys.ts lines 25-33
 */
export interface KeyPair {
  id: string
  alg: string
  public: KeyLike
  private: KeyLike
  created: Date
  expired?: Date
  jwk: JWK
}

/**
 * Get all signing keys from storage, generating a new one if needed
 * Based on OpenAuth: packages/openauth/src/keys.ts lines 64-100
 * 
 * This function:
 * 1. Scans storage for existing keys
 * 2. Loads and deserializes them
 * 3. Sorts by creation date (newest first)
 * 4. If no valid (non-expired) keys exist, generates a new one
 */
export async function signingKeys(storage: StorageAdapter): Promise<KeyPair[]> {
  const results = [] as KeyPair[]
  
  // Scan for existing keys
  // OpenAuth uses ["signing:key"] prefix for ES256 keys
  const scanner = Storage.scan<SerializedKeyPair>(storage, ["signing:key"])
  
  for await (const [_key, value] of scanner) {
    // Import the serialized keys back to KeyLike format
    const publicKey = await importSPKI(value.publicKey, value.alg, {
      extractable: true,
    })
    const privateKey = await importPKCS8(value.privateKey, value.alg)
    
    // Generate JWK for JWKS endpoint
    const jwk = await exportJWK(publicKey)
    jwk.kid = value.id
    jwk.use = "sig"
    
    results.push({
      id: value.id,
      alg: signingAlg,
      created: new Date(value.created),
      expired: value.expired ? new Date(value.expired) : undefined,
      public: publicKey,
      private: privateKey,
      jwk,
    })
  }
  
  // Sort by creation date, newest first
  results.sort((a, b) => b.created.getTime() - a.created.getTime())
  
  // If we have at least one non-expired key, return all keys
  if (results.filter((item) => !item.expired).length) return results
  
  // No valid keys found, generate a new one
  const key = await generateKeyPair(signingAlg, {
    extractable: true,
  })
  
  const serialized: SerializedKeyPair = {
    id: crypto.randomUUID(),
    publicKey: await exportSPKI(key.publicKey),
    privateKey: await exportPKCS8(key.privateKey),
    created: Date.now(),
    alg: signingAlg,
  }
  
  // Store the new key
  await Storage.set(storage, ["signing:key", serialized.id], serialized)
  
  // Recursively call to return the newly created key
  return signingKeys(storage)
}

/**
 * Mark a key as expired (for rotation)
 * This is used when rotating keys - old keys are kept for verification
 * but marked as expired so they won't be used for new signatures
 */
export async function expireKey(
  storage: StorageAdapter,
  keyId: string
): Promise<void> {
  const existing = await Storage.get<SerializedKeyPair>(
    storage,
    ["signing:key", keyId]
  )
  
  if (existing) {
    existing.expired = Date.now()
    await Storage.set(storage, ["signing:key", keyId], existing)
  }
}

/**
 * Get the current (latest) signing key
 * Always returns the newest non-expired key
 */
export async function currentSigningKey(
  storage: StorageAdapter
): Promise<KeyPair> {
  const keys = await signingKeys(storage)
  const valid = keys.find(k => !k.expired)
  
  if (!valid) {
    throw new Error("No valid signing key available")
  }
  
  return valid
}