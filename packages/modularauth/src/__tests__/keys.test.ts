import { describe, it, expect, beforeEach } from 'vitest'
import { signingKeys, currentSigningKey, expireKey } from '../core/keys.js'
import { MemoryStorage } from '../storage/memory.js'
import { Storage } from '../storage/index.js'
import type { StorageAdapter } from '../core/types.js'

describe('Key Management', () => {
  let storage: StorageAdapter
  
  beforeEach(() => {
    storage = MemoryStorage()
  })
  
  describe('signingKeys', () => {
    it('should generate a new key when none exist', async () => {
      const keys = await signingKeys(storage)
      
      expect(keys).toHaveLength(1)
      expect(keys[0]).toMatchObject({
        alg: 'ES256',
        id: expect.any(String),
        created: expect.any(Date),
      })
      expect(keys[0].public).toBeDefined()
      expect(keys[0].private).toBeDefined()
      expect(keys[0].jwk).toMatchObject({
        kid: keys[0].id,
        use: 'sig',
        kty: 'EC', // ES256 uses Elliptic Curve
      })
    })
    
    it('should persist keys to storage', async () => {
      // Generate first key
      const keys1 = await signingKeys(storage)
      const keyId = keys1[0].id
      
      // Verify it's stored
      const stored = await Storage.get(storage, ['signing:key', keyId])
      expect(stored).toBeDefined()
      expect(stored).toMatchObject({
        id: keyId,
        alg: 'ES256',
        publicKey: expect.any(String),
        privateKey: expect.any(String),
        created: expect.any(Number),
      })
      
      // Load keys again - should get the same key, not generate a new one
      const keys2 = await signingKeys(storage)
      expect(keys2).toHaveLength(1)
      expect(keys2[0].id).toBe(keyId)
    })
    
    it('should return multiple keys sorted by creation date', async () => {
      // Generate first key
      const keys1 = await signingKeys(storage)
      const firstKeyId = keys1[0].id
      
      // Wait a bit to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10))
      
      // Manually add a second key (simulating rotation)
      const { exportSPKI, exportPKCS8, generateKeyPair } = await import('jose')
      const newKey = await generateKeyPair('ES256', { extractable: true })
      const secondKeyId = crypto.randomUUID()
      
      await Storage.set(storage, ['signing:key', secondKeyId], {
        id: secondKeyId,
        publicKey: await exportSPKI(newKey.publicKey),
        privateKey: await exportPKCS8(newKey.privateKey),
        created: Date.now(),
        alg: 'ES256',
      })
      
      // Load all keys
      const allKeys = await signingKeys(storage)
      
      expect(allKeys).toHaveLength(2)
      // Should be sorted with newest first
      expect(allKeys[0].id).toBe(secondKeyId)
      expect(allKeys[1].id).toBe(firstKeyId)
    })
    
    it('should generate new key if all existing keys are expired', async () => {
      // Generate and immediately expire a key
      const keys1 = await signingKeys(storage)
      const oldKeyId = keys1[0].id
      
      // Mark it as expired
      await expireKey(storage, oldKeyId)
      
      // Request keys again - should generate a new one
      const keys2 = await signingKeys(storage)
      
      // Should have 2 keys: the new one and the expired one
      expect(keys2.length).toBeGreaterThanOrEqual(2)
      
      // First key should be the new one (not expired)
      expect(keys2[0].expired).toBeUndefined()
      expect(keys2[0].id).not.toBe(oldKeyId)
      
      // Should still have the old expired key for verification
      const expiredKey = keys2.find(k => k.id === oldKeyId)
      expect(expiredKey).toBeDefined()
      expect(expiredKey?.expired).toBeDefined()
    })
  })
  
  describe('currentSigningKey', () => {
    it('should return the latest non-expired key', async () => {
      // Generate a key
      await signingKeys(storage)
      
      const current = await currentSigningKey(storage)
      
      expect(current).toBeDefined()
      expect(current.expired).toBeUndefined()
      expect(current.alg).toBe('ES256')
    })
    
    it('should generate a key if none exist', async () => {
      // When no keys exist, it should auto-generate one
      const current = await currentSigningKey(storage)
      
      expect(current).toBeDefined()
      expect(current.expired).toBeUndefined()
      expect(current.alg).toBe('ES256')
    })
    
    it('should skip expired keys', async () => {
      // Generate first key and expire it
      const keys1 = await signingKeys(storage)
      await expireKey(storage, keys1[0].id)
      
      // Generate a new key
      const keys2 = await signingKeys(storage)
      const validKey = keys2.find(k => !k.expired)
      
      // Current key should be the non-expired one
      const current = await currentSigningKey(storage)
      expect(current.id).toBe(validKey?.id)
      expect(current.expired).toBeUndefined()
    })
  })
  
  describe('expireKey', () => {
    it('should mark a key as expired', async () => {
      const keys = await signingKeys(storage)
      const keyId = keys[0].id
      
      // Key should not be expired initially
      expect(keys[0].expired).toBeUndefined()
      
      // Expire the key
      await expireKey(storage, keyId)
      
      // Load keys again
      const updatedKeys = await signingKeys(storage)
      
      // Should have generated a new key since all were expired
      expect(updatedKeys.length).toBeGreaterThanOrEqual(2)
      
      // Find the expired key
      const expiredKey = updatedKeys.find(k => k.id === keyId)
      expect(expiredKey?.expired).toBeDefined()
    })
    
    it('should handle non-existent keys gracefully', async () => {
      // Should not throw when expiring non-existent key
      await expect(expireKey(storage, 'non-existent')).resolves.toBeUndefined()
    })
  })
})