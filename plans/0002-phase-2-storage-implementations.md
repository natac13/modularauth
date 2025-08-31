# 0002: Phase 2 - Storage Implementations

## Context

**What was completed in Phase 1:**
- ✅ Core ModularAuth class with request/response handling
- ✅ Provider system with OTP provider working end-to-end
- ✅ JWT token management with OpenAuth's key rotation
- ✅ Complete OAuth authorization code flow
- ✅ Structured error types (no magic strings)
- ✅ OpenAuth's proven StorageAdapter interface adopted

**What comes after Phase 2:**
Phase 3 will add OAuth providers (Google, GitHub) and Phase 4 will create the client library.

## Goal

Create additional storage implementations beyond MemoryStorage to support production deployments. Focus on the most common storage backends that users will need.

## Current State

We have:
- `MemoryStorage` working (copied from OpenAuth)
- `StorageAdapter` interface defined and tested
- Storage usage throughout ModularAuth following OpenAuth patterns

## Tasks

### Task 1: Create DynamoDB Storage Implementation

**Why DynamoDB**: Most common serverless storage choice, especially for Lambda/edge deployments.

**File to create**: `packages/modularauth/src/storage/dynamodb.ts`

**CRITICAL: Copy OpenAuth's Pattern Exactly**
- **Source**: `/Users/natac/code/forks/openauthjs/packages/openauth/src/storage/dynamo.ts`
- **AWS Client**: Copy `/Users/natac/code/forks/openauthjs/packages/openauth/src/storage/aws.ts`
- **Key requirement**: Use `aws4fetch`, NOT AWS SDK (for Cloudflare Workers compatibility)

**Requirements**:
1. Copy OpenAuth's DynamoDB implementation exactly
2. Use `aws4fetch` for HTTP-level AWS API calls (edge runtime compatible)
3. Copy OpenAuth's key parsing logic (`parseKey` function)
4. Use same table structure: `pk`, `sk`, `value`, `ttl` fields
5. Copy the `dynamo()` helper function for HTTP requests
6. Handle credentials the same way (env vars + container metadata)

**Key design decisions (from OpenAuth)**:
- **Primary/Sort Keys**: Support both `pk`/`sk` pattern and single key
- **Key parsing**: Use OpenAuth's `parseKey` logic for array keys
- **HTTP requests**: Use `aws4fetch.AwsClient` with signed requests
- **TTL handling**: Server-side TTL validation + DynamoDB TTL
- **Credential chain**: Env vars → container metadata → error

**Testing approach**:
- Unit tests with fetch mocking (not AWS SDK mocking)
- Compliance tests using existing storage test suite
- Test credential resolution patterns

### Task 2: Create Redis/Upstash Storage Implementation

**Why Redis**: Popular for high-performance caching and session storage.

**File to create**: `packages/modularauth/src/storage/redis.ts`

**Requirements**:
1. Support both regular Redis and Upstash (serverless Redis)
2. Use Redis TTL for expiration
3. Key joining strategy for hierarchical storage
4. Connection pooling considerations

**Design approach**:
- Keys: Use `:` separator for Redis conventions (`oauth:refresh:token123`)
- Values: Store as JSON strings
- TTL: Use Redis SETEX for atomic set-with-expiry

### Task 3: Document Storage Interface for Community

**File to create**: `packages/modularauth/src/storage/README.md`

**Content**:
1. Storage interface explanation
2. Key patterns used by ModularAuth
3. TTL requirements and behavior
4. Implementation guidelines for new storage adapters
5. Testing requirements for compliance

### Task 4: Add Storage Exports and Testing

**Update files**:
- `packages/modularauth/src/storage/index.ts` - export new implementations
- `packages/modularauth/src/index.ts` - export storage classes
- `packages/modularauth/src/__tests__/storage-compliance.test.ts` - test all implementations

## Implementation Notes

### CRITICAL: Copy OpenAuth Exactly
- **Don't innovate**: Copy OpenAuth's storage implementations line-by-line
- **Same dependencies**: Use `aws4fetch`, not AWS SDK for edge compatibility  
- **Same patterns**: Key parsing, credential resolution, error handling
- **Same configuration**: Options interface should match OpenAuth's patterns

### Storage Key Patterns (from OpenAuth)
```typescript
// These are the key patterns ModularAuth uses:
["oauth:refresh", refreshToken]           // Refresh token data
["oauth:code", authorizationCode]         // Authorization code session
["oauth:authorization", code]             // Authorization state
["verification", "otp", email]            // OTP verification challenges
["jwt:keys", keyId]                       // JWT signing keys
```

### Configuration Pattern (Copy from OpenAuth)
```typescript
// Use OpenAuth's exact configuration interface
interface DynamoStorageOptions {
  table: string
  pk?: string      // Default: "pk"
  sk?: string      // Default: "sk"  
  ttl?: string     // Default: "expiry"
  endpoint?: string // For local testing
}
```

### Key Files to Copy
1. **DynamoDB**: Copy `packages/openauth/src/storage/dynamo.ts` exactly
2. **AWS Client**: Copy `packages/openauth/src/storage/aws.ts` exactly
3. **Key utilities**: Use existing `joinKey` from OpenAuth patterns

## Success Criteria

- [ ] DynamoDB storage passes all compliance tests
- [ ] Redis storage passes all compliance tests  
- [ ] Example configurations documented
- [ ] Performance is reasonable (< 100ms for get/set operations)
- [ ] Error handling follows OAuth patterns
- [ ] No breaking changes to existing MemoryStorage usage

## Files to Create/Modify

### New Files
- `packages/modularauth/src/storage/dynamodb.ts`
- `packages/modularauth/src/storage/redis.ts` 
- `packages/modularauth/src/storage/README.md`

### Modified Files
- `packages/modularauth/src/storage/index.ts` (add exports)
- `packages/modularauth/src/index.ts` (add exports)
- `packages/modularauth/package.json` (add optional dependencies)

## Time Estimate

**2-3 hours total**:
- DynamoDB implementation: 1 hour
- Redis implementation: 45 minutes  
- Documentation and testing: 45 minutes
- Integration and cleanup: 30 minutes

## Dependencies

**IMPORTANT**: Follow OpenAuth's dependency pattern exactly.

```json
{
  "optionalDependencies": {
    "aws4fetch": "^1.x",  // NOT AWS SDK - for edge compatibility
    "redis": "^4.x",
    "@upstash/redis": "^1.x"
  }
}
```

**Why `aws4fetch` instead of AWS SDK**:
- Works in Cloudflare Workers, Deno, Bun, and other edge runtimes
- Much smaller bundle size
- HTTP-level control over requests
- Same security (proper AWS v4 signing)

Use optional dependencies so users only install what they need.