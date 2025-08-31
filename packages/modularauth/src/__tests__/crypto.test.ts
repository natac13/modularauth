import { describe, it, expect } from 'vitest'
import { generateUnbiasedDigits, timingSafeCompare } from '../utils/random.js'

describe('Crypto Utilities', () => {
  describe('generateUnbiasedDigits', () => {
    it('should generate correct length', () => {
      expect(generateUnbiasedDigits(6)).toHaveLength(6)
      expect(generateUnbiasedDigits(4)).toHaveLength(4)
      expect(generateUnbiasedDigits(8)).toHaveLength(8)
      expect(generateUnbiasedDigits(10)).toHaveLength(10)
    })
    
    it('should only contain digits', () => {
      const code = generateUnbiasedDigits(100)
      expect(code).toMatch(/^\d+$/)
    })
    
    it('should generate different codes each time', () => {
      const codes = new Set()
      for (let i = 0; i < 100; i++) {
        codes.add(generateUnbiasedDigits(6))
      }
      // Should have at least 95 unique codes out of 100
      expect(codes.size).toBeGreaterThan(95)
    })
    
    it('should be unbiased (no repeated patterns)', () => {
      const codes = Array.from({ length: 1000 }, () => generateUnbiasedDigits(6))
      const unique = new Set(codes)
      // Should be mostly unique (at least 900 out of 1000)
      expect(unique.size).toBeGreaterThan(900)
    })
    
    it('should have uniform distribution of digits', () => {
      // Generate many digits and check distribution
      const digitCounts = new Array(10).fill(0)
      const totalDigits = 10000
      
      for (let i = 0; i < totalDigits / 6; i++) {
        const code = generateUnbiasedDigits(6)
        for (const digit of code) {
          digitCounts[parseInt(digit)]++
        }
      }
      
      // Each digit should appear roughly 10% of the time (±2%)
      const expectedCount = totalDigits / 10
      for (let i = 0; i < 10; i++) {
        const ratio = digitCounts[i] / expectedCount
        expect(ratio).toBeGreaterThan(0.8) // Allow 20% deviation
        expect(ratio).toBeLessThan(1.2)
      }
    })
  })
  
  describe('timingSafeCompare', () => {
    it('should return true for identical strings', () => {
      expect(timingSafeCompare('123456', '123456')).toBe(true)
      expect(timingSafeCompare('abcdef', 'abcdef')).toBe(true)
      expect(timingSafeCompare('', '')).toBe(true)
      expect(timingSafeCompare('a very long string with spaces', 'a very long string with spaces')).toBe(true)
    })
    
    it('should return false for different strings', () => {
      expect(timingSafeCompare('123456', '654321')).toBe(false)
      expect(timingSafeCompare('abcdef', 'abcdeg')).toBe(false)
      expect(timingSafeCompare('test', 'test2')).toBe(false)
    })
    
    it('should return false for different lengths', () => {
      expect(timingSafeCompare('123456', '1234')).toBe(false)
      expect(timingSafeCompare('abc', 'abcd')).toBe(false)
      expect(timingSafeCompare('', 'a')).toBe(false)
    })
    
    it('should handle non-string inputs gracefully', () => {
      expect(timingSafeCompare(null as any, '123')).toBe(false)
      expect(timingSafeCompare('123', null as any)).toBe(false)
      expect(timingSafeCompare(undefined as any, '123')).toBe(false)
      expect(timingSafeCompare('123', undefined as any)).toBe(false)
      expect(timingSafeCompare(123 as any, '123')).toBe(false)
      expect(timingSafeCompare('123', 123 as any)).toBe(false)
    })
    
    it('should be case sensitive', () => {
      expect(timingSafeCompare('ABC', 'abc')).toBe(false)
      expect(timingSafeCompare('Test', 'test')).toBe(false)
    })
    
    it('should handle special characters', () => {
      expect(timingSafeCompare('!@#$%^', '!@#$%^')).toBe(true)
      expect(timingSafeCompare('🔐🔑', '🔐🔑')).toBe(true)
      expect(timingSafeCompare('line\nbreak', 'line\nbreak')).toBe(true)
      expect(timingSafeCompare('tab\ttab', 'tab\ttab')).toBe(true)
    })
  })
})