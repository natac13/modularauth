import { describe, it, expect } from 'vitest'
import { MemoryStorage } from '../storage/memory.js'
import { Storage } from '../storage/index.js'

describe('MemoryStorage', () => {
  it('should store and retrieve values', async () => {
    const storage = MemoryStorage()
    
    // Store a value
    await Storage.set(storage, ['test', 'key'], { data: 'test-value' })
    
    // Retrieve the value
    const retrieved = await Storage.get(storage, ['test', 'key'])
    
    expect(retrieved).toEqual({ data: 'test-value' })
  })

  it('should handle TTL expiry', async () => {
    const storage = MemoryStorage()
    
    // Store with 1 second TTL
    await Storage.set(storage, ['test', 'expiring'], { data: 'expires' }, 1)
    
    // Should exist immediately
    const beforeExpiry = await Storage.get(storage, ['test', 'expiring'])
    expect(beforeExpiry).toEqual({ data: 'expires' })
    
    // Wait for expiry
    await new Promise(resolve => setTimeout(resolve, 1100))
    
    // Should be expired
    const afterExpiry = await Storage.get(storage, ['test', 'expiring'])
    expect(afterExpiry).toBeUndefined()
  })

  it('should remove values', async () => {
    const storage = MemoryStorage()
    
    // Store a value
    await Storage.set(storage, ['test', 'removable'], { data: 'remove-me' })
    
    // Verify it exists
    const exists = await Storage.get(storage, ['test', 'removable'])
    expect(exists).toEqual({ data: 'remove-me' })
    
    // Remove it
    await Storage.remove(storage, ['test', 'removable'])
    
    // Should be gone
    const removed = await Storage.get(storage, ['test', 'removable'])
    expect(removed).toBeUndefined()
  })

  it('should scan with prefix', async () => {
    const storage = MemoryStorage()
    
    // Store multiple values
    await Storage.set(storage, ['users', 'alice'], { name: 'Alice' })
    await Storage.set(storage, ['users', 'bob'], { name: 'Bob' })
    await Storage.set(storage, ['posts', 'post1'], { title: 'Post 1' })
    
    // Scan for users
    const users = []
    for await (const [key, value] of Storage.scan(storage, ['users'])) {
      users.push({ key, value })
    }
    
    expect(users).toHaveLength(2)
    expect(users.map(u => u.value.name).sort()).toEqual(['Alice', 'Bob'])
  })
})