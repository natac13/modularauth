import { describe, it, expect, beforeEach } from "vitest"
import { MemoryStorage } from "../storage/memory.js"
import type { StorageAdapter } from "../core/types.js"

/**
 * Storage Compliance Test Suite
 *
 * All storage adapters should pass these tests to ensure they
 * correctly implement the StorageAdapter interface.
 */
function testStorageCompliance(
  name: string,
  createStorage: () => StorageAdapter | Promise<StorageAdapter>,
) {
  describe(`${name} Storage Compliance`, () => {
    let storage: StorageAdapter

    beforeEach(async () => {
      storage = await createStorage()
    })

    describe("get/set operations", () => {
      it("should store and retrieve simple values", async () => {
        const key = ["test", "simple"]
        const value = { data: "test value", count: 42 }

        await storage.set(key, value)
        const retrieved = await storage.get(key)

        expect(retrieved).toEqual(value)
      })

      it("should store and retrieve complex nested objects", async () => {
        const key = ["test", "complex"]
        const value = {
          user: {
            id: "user-123",
            email: "test@example.com",
            metadata: {
              roles: ["admin", "user"],
              settings: {
                theme: "dark",
                notifications: true,
              },
            },
          },
          timestamp: Date.now(),
        }

        await storage.set(key, value)
        const retrieved = await storage.get(key)

        expect(retrieved).toEqual(value)
      })

      it("should handle multi-part keys", async () => {
        const key = ["oauth", "refresh", "user-123", "token-456"]
        const value = { subject: { type: "user", properties: { id: "123" } } }

        await storage.set(key, value)
        const retrieved = await storage.get(key)

        expect(retrieved).toEqual(value)
      })

      it("should return undefined for non-existent keys", async () => {
        const result = await storage.get(["non", "existent", "key"])
        expect(result).toBeUndefined()
      })

      it("should overwrite existing values", async () => {
        const key = ["test", "overwrite"]
        const value1 = { version: 1 }
        const value2 = { version: 2 }

        await storage.set(key, value1)
        await storage.set(key, value2)
        const retrieved = await storage.get(key)

        expect(retrieved).toEqual(value2)
      })
    })

    describe("TTL/expiry handling", () => {
      it("should respect TTL for expired items", async () => {
        const key = ["test", "expired"]
        const value = { data: "expires soon" }
        const expiry = new Date(Date.now() - 1000) // Already expired

        await storage.set(key, value, expiry)
        const retrieved = await storage.get(key)

        // Should not return expired data
        expect(retrieved).toBeUndefined()
      })

      it("should return non-expired items", async () => {
        const key = ["test", "not-expired"]
        const value = { data: "still valid" }
        const expiry = new Date(Date.now() + 60000) // Expires in 1 minute

        await storage.set(key, value, expiry)
        const retrieved = await storage.get(key)

        expect(retrieved).toEqual(value)
      })

      it("should handle items without TTL", async () => {
        const key = ["test", "no-ttl"]
        const value = { data: "permanent" }

        await storage.set(key, value) // No expiry
        const retrieved = await storage.get(key)

        expect(retrieved).toEqual(value)
      })

      it("should handle TTL expiry over time", async () => {
        const key = ["test", "expires-later"]
        const value = { data: "expires in 100ms" }
        const expiry = new Date(Date.now() + 100)

        await storage.set(key, value, expiry)

        // Should exist immediately
        const immediate = await storage.get(key)
        expect(immediate).toEqual(value)

        // Wait for expiry
        await new Promise((resolve) => setTimeout(resolve, 150))

        // Should be expired now
        const afterExpiry = await storage.get(key)
        expect(afterExpiry).toBeUndefined()
      })
    })

    describe("remove operations", () => {
      it("should remove existing keys", async () => {
        const key = ["test", "remove"]
        const value = { data: "to be removed" }

        await storage.set(key, value)
        const beforeRemove = await storage.get(key)
        expect(beforeRemove).toEqual(value)

        await storage.remove(key)
        const afterRemove = await storage.get(key)
        expect(afterRemove).toBeUndefined()
      })

      it("should handle removing non-existent keys", async () => {
        // Should not throw when removing non-existent key
        await expect(
          storage.remove(["non", "existent"]),
        ).resolves.toBeUndefined()
      })
    })

    describe("scan operations", () => {
      it("should scan keys with prefix", async () => {
        // Set up test data
        await storage.set(["users", "user1"], { id: "user1" })
        await storage.set(["users", "user2"], { id: "user2" })
        await storage.set(["users", "profiles", "user1"], { name: "User 1" })
        await storage.set(["posts", "post1"], { id: "post1" })

        // Scan with "users" prefix
        const results: Array<[string[], any]> = []
        for await (const entry of storage.scan(["users"])) {
          results.push(entry)
        }

        // Should return all keys starting with "users"
        expect(results.length).toBeGreaterThanOrEqual(2)

        const ids = results.map(([_, value]) => value.id).filter(Boolean)
        expect(ids).toContain("user1")
        expect(ids).toContain("user2")

        // Should not include "posts"
        const hasPost = results.some(([_, value]) => value.id === "post1")
        expect(hasPost).toBe(false)
      })

      it("should handle empty scan results", async () => {
        const results: Array<[string[], any]> = []
        for await (const entry of storage.scan(["nonexistent", "prefix"])) {
          results.push(entry)
        }

        expect(results).toHaveLength(0)
      })

      it("should exclude expired items from scan", async () => {
        const expiredTime = new Date(Date.now() - 1000)
        const validTime = new Date(Date.now() + 60000)

        await storage.set(["scan", "expired"], { id: "expired" }, expiredTime)
        await storage.set(["scan", "valid"], { id: "valid" }, validTime)

        const results: Array<[string[], any]> = []
        for await (const entry of storage.scan(["scan"])) {
          results.push(entry)
        }

        // Should only return non-expired items
        expect(results).toHaveLength(1)
        expect(results[0][1]).toEqual({ id: "valid" })
      })
    })

    describe("OAuth-specific patterns", () => {
      it("should handle refresh token storage", async () => {
        const refreshToken = "refresh_token_abc123"
        const key = ["oauth:refresh", refreshToken]
        const value = {
          subject: {
            type: "user",
            properties: {
              userId: "user-123",
              email: "user@example.com",
            },
          },
        }
        const ttl = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days

        await storage.set(key, value, ttl)
        const retrieved = await storage.get(key)

        expect(retrieved).toEqual(value)
      })

      it("should handle authorization code storage", async () => {
        const code = "auth_code_xyz789"
        const key = ["oauth:code", code]
        const value = {
          clientId: "client-123",
          redirectUri: "https://example.com/callback",
          state: "random-state",
          subject: { type: "user", properties: { id: "user-123" } },
        }
        const ttl = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

        await storage.set(key, value, ttl)
        const retrieved = await storage.get(key)

        expect(retrieved).toEqual(value)
      })

      it("should handle OTP code storage", async () => {
        const email = "user@example.com"
        const code = "123456"
        const key = ["verification", "otp", email]
        const value = {
          code,
          attempts: 0,
          createdAt: Date.now(),
        }
        const ttl = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

        await storage.set(key, value, ttl)
        const retrieved = await storage.get(key)

        expect(retrieved).toEqual(value)
      })

      it("should handle JWT key storage", async () => {
        const keyId = "key-2024-01"
        const key = ["jwt:keys", keyId]
        const value = {
          publicKey: "-----BEGIN PUBLIC KEY-----...",
          privateKey: "-----BEGIN PRIVATE KEY-----...",
          algorithm: "RS256",
          createdAt: Date.now(),
        }

        // JWT keys typically don't expire
        await storage.set(key, value)
        const retrieved = await storage.get(key)

        expect(retrieved).toEqual(value)
      })
    })

    describe("edge cases", () => {
      it("should handle empty arrays as values", async () => {
        const key = ["test", "empty-array"]
        const value: any[] = []

        await storage.set(key, value)
        const retrieved = await storage.get(key)

        expect(retrieved).toEqual(value)
      })

      it("should handle null values", async () => {
        const key = ["test", "null"]
        const value = null

        await storage.set(key, value)
        const retrieved = await storage.get(key)

        expect(retrieved).toBe(null)
      })

      it("should handle special characters in keys", async () => {
        const key = ["test", "special:chars@example.com", "with spaces"]
        const value = { data: "special" }

        await storage.set(key, value)
        const retrieved = await storage.get(key)

        expect(retrieved).toEqual(value)
      })

      it("should handle very long key arrays", async () => {
        const key = ["level1", "level2", "level3", "level4", "level5", "level6"]
        const value = { depth: 6 }

        await storage.set(key, value)
        const retrieved = await storage.get(key)

        expect(retrieved).toEqual(value)
      })
    })
  })
}

// Test MemoryStorage
testStorageCompliance("Memory", () => MemoryStorage())

// Note: To test DynamoDB and Redis storage adapters, you would need to:
// 1. Set up the appropriate test infrastructure (local DynamoDB, Redis container)
// 2. Add the following test cases:
//
// testStorageCompliance("DynamoDB", async () => {
//   return DynamoStorage({
//     table: "test-auth-table",
//     endpoint: "http://localhost:8000" // Local DynamoDB
//   })
// })
//
// testStorageCompliance("Redis", async () => {
//   const client = createClient({ url: "redis://localhost:6379" })
//   await client.connect()
//   return RedisStorage({ client, prefix: "test" })
// })
