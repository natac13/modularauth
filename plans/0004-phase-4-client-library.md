# 0004: Phase 4 - Client Library with Auto-Refresh

## Context

**What was completed in Phases 1-3:**
- ✅ Core ModularAuth server working with OAuth 2.0/OIDC compliance
- ✅ Storage implementations (Memory, DynamoDB, Redis)
- ✅ Provider system (OTP, Google, GitHub) with end-to-end flows
- ✅ JWT token issuance with 10-minute access tokens and 30-day refresh tokens

**What comes after Phase 4:**
Phase 5 will add React integration and comprehensive testing/documentation.

## Goal

Create a client library that provides seamless authentication with automatic token refresh, similar to OpenAuth's client but adapted for our modular architecture and short-lived tokens.

## Current Token Architecture

ModularAuth issues:
- **Access tokens**: 10 minutes (short-lived for security)
- **Refresh tokens**: 30 days (long-lived for convenience)
- **Auto-refresh needed**: Because of short access token lifetime

## Key Features Required

1. **Automatic refresh** when access tokens expire
2. **Framework agnostic** (works with any JavaScript environment)
3. **OpenAuth-compatible** `verify()` method with auto-refresh
4. **Simple API** for common authentication operations
5. **Type safety** throughout with proper generics

## Tasks

### Task 1: Create Core Client Class

**File to create**: `packages/modularauth/src/client/index.ts`

**Design**: Follow OpenAuth's client pattern but add auto-refresh capability.

```typescript
export class AuthClient {
  constructor(config: ClientConfig) {}

  // Core verification with auto-refresh (like OpenAuth)
  async verify(token: string, options?: { 
    refresh?: string 
  }): Promise<VerifyResult>

  // Get current session with auto-refresh
  async getSession(): Promise<Session | null>

  // Manual refresh
  async refresh(refreshToken: string): Promise<TokenResponse>
  
  // Sign out
  async signOut(): Promise<void>
}
```

**Key implementation details**:
- **Auto-refresh logic**: When `verify()` gets expired token + refresh token, automatically refresh
- **Token storage**: Client can store tokens or user manages them
- **Error handling**: Use structured errors matching server-side patterns

### Task 2: Add Sign-In Methods

**Goal**: Provide simple sign-in methods for each provider type.

```typescript
interface SignInMethods {
  // OAuth providers (redirect-based)
  social(provider: string, redirectTo?: string): Promise<void>
  
  // OTP providers (API-based)  
  email(email: string): Promise<{ sent: boolean }>
  verifyEmail(email: string, code: string): Promise<TokenResponse>
  
  // Future: Passkey support
  passkey(): Promise<TokenResponse>
}
```

**Implementation approach**:
- **Social sign-in**: Redirect to `/api/auth/authorize?provider=google`
- **Email OTP**: POST to `/api/auth/email/authorize` then `/api/auth/email/callback`
- **Error handling**: Consistent error types across all methods

### Task 3: Token Management and Storage

**File to create**: `packages/modularauth/src/client/storage.ts`

**Features**:
```typescript
interface TokenStorage {
  getTokens(): Promise<{ access?: string, refresh?: string }>
  setTokens(access: string, refresh?: string): Promise<void>
  clearTokens(): Promise<void>
}

// Default implementations
export class CookieStorage implements TokenStorage {}
export class LocalStorage implements TokenStorage {}  
export class MemoryStorage implements TokenStorage {}
```

**Design principles**:
- **Pluggable storage**: Users can choose storage mechanism
- **Secure defaults**: HTTPOnly cookies for server-side, localStorage for SPA
- **SSR compatibility**: Works in both browser and server environments

### Task 4: Auto-Refresh Implementation

**Core logic**: 
1. Decode access token to get expiry
2. If expired and refresh token available, attempt refresh
3. Return new tokens or error
4. Optionally set up timer for proactive refresh

```typescript
class RefreshManager {
  private refreshTimer?: NodeJS.Timeout
  
  setupAutoRefresh(accessToken: string, refreshToken: string) {
    // Calculate refresh timing (1 minute before expiry)
    const payload = this.decodeJWT(accessToken)
    const refreshAt = (payload.exp * 1000) - (60 * 1000)
    
    if (refreshAt > Date.now()) {
      this.refreshTimer = setTimeout(() => {
        this.refresh(refreshToken)
      }, refreshAt - Date.now())
    }
  }
}
```

### Task 5: Framework Integration Helpers

**File to create**: `packages/modularauth/src/client/frameworks.ts`

**Purpose**: Helper functions for common framework patterns.

```typescript
// Next.js integration
export function withAuth(handler: NextApiHandler): NextApiHandler

// Express/Node.js integration  
export function createAuthMiddleware(client: AuthClient): RequestHandler

// SPA integration
export function createSPAClient(config: ClientConfig): AuthClient
```

## Implementation Strategy

### Follow OpenAuth Client Patterns

**Copy these patterns from OpenAuth**:
1. **`verify()` method signature**: Same API as OpenAuth for compatibility
2. **Error handling**: Same error types and response format
3. **Token format**: Expect same JWT structure and claims
4. **Configuration**: Similar config options where applicable

**Key differences from OpenAuth**:
- **Auto-refresh built-in**: OpenAuth's verify() does manual refresh, ours is automatic
- **Shorter tokens**: Designed for 10-minute access tokens instead of 30-day
- **Framework agnostic**: Not tied to specific server framework

### Testing Strategy

**Unit tests**:
- Token parsing and validation
- Auto-refresh logic with mocked timers
- Storage implementation compliance
- Error handling scenarios

**Integration tests**:
- Complete sign-in flows with test server
- Token refresh with real JWT tokens
- Cross-browser compatibility (if browser features used)

## Example Usage

After Phase 4, users should be able to:

```typescript
import { createAuthClient } from '@modularauth/client'

// Basic client
const client = createAuthClient({
  baseURL: '/api/auth',
  autoRefresh: true
})

// Social sign-in
await client.signIn.social('google', '/dashboard')

// Email OTP sign-in
await client.signIn.email('user@example.com')
await client.signIn.verifyEmail('user@example.com', '123456')

// Get current user (auto-refreshes if needed)
const session = await client.getSession()
if (session?.user) {
  console.log('Logged in:', session.user.email)
}

// Verify tokens (for API middleware)
const result = await client.verify(accessToken, { 
  refresh: refreshToken // Auto-refreshes if access token expired
})

if (result.tokens) {
  // New tokens were issued, update storage
  await client.storage.setTokens(result.tokens.access, result.tokens.refresh)
}
```

## Success Criteria

- [ ] `verify()` method works like OpenAuth but with auto-refresh
- [ ] All provider sign-in methods working (social, email OTP)
- [ ] Automatic refresh happens transparently to users
- [ ] Token storage is pluggable and secure
- [ ] Client works in browser, Node.js, and edge environments
- [ ] Error handling consistent with server-side errors
- [ ] TypeScript types are properly inferred throughout
- [ ] No dependencies on specific frameworks (truly framework-agnostic)

## Files to Create

### New Package Structure
```
packages/client/
├── src/
│   ├── index.ts          # Main AuthClient class
│   ├── storage.ts        # Token storage implementations  
│   ├── frameworks.ts     # Framework-specific helpers
│   ├── types.ts          # TypeScript types
│   └── utils.ts          # JWT parsing, etc.
├── package.json
└── README.md
```

### Test Files
- `packages/client/src/__tests__/client.test.ts`
- `packages/client/src/__tests__/auto-refresh.test.ts`  
- `packages/client/src/__tests__/storage.test.ts`

## Time Estimate

**4-5 hours total**:
- Core client class with verify(): 1.5 hours
- Sign-in methods: 1.5 hours  
- Auto-refresh implementation: 1 hour
- Storage and framework helpers: 1 hour
- Testing and documentation: 1 hour

## Dependencies

```json
{
  "dependencies": {
    "jose": "^5.x"  // For JWT parsing (same as server)
  },
  "peerDependencies": {
    // None - truly framework agnostic
  }
}
```

## Integration Notes

### Server Compatibility
- Client expects server endpoints at `/api/auth/*`  
- Client sends same requests as manual OAuth flows
- Client expects same JWT format as server issues
- Client uses same error response format as server

### Security Considerations
- **Token storage**: Provide secure defaults but allow customization
- **HTTPS only**: Enforce secure transport for token operations
- **CSRF protection**: Include appropriate headers for state validation
- **XSS protection**: Don't store sensitive tokens in unsafe storage

This phase creates the essential client library that makes ModularAuth easy to use while maintaining security and performance through automatic token refresh.