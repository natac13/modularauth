# OpenAuth Architecture Analysis

## Overview
OpenAuth is a monolithic Hono-based auth server that handles OAuth 2.0/OIDC flows. Understanding its patterns is crucial for building ModularAuth.

## Core Flow Architecture

### 1. Authorization Endpoint (`/authorize`)
**Location**: `packages/openauth/src/issuer.ts:1007-1075`

**Key responsibilities**:
- Validates required OAuth parameters (`client_id`, `redirect_uri`, `response_type`)
- Creates `AuthorizationState` object and stores it in session storage
- Handles PKCE parameters (`code_challenge`, `code_challenge_method`)
- Routes to specific provider or shows provider selection UI

**Critical pattern**:
```typescript
const authorization: AuthorizationState = {
  response_type,
  redirect_uri, 
  state,
  client_id,
  audience,
  pkce: code_challenge ? { challenge: code_challenge, method: code_challenge_method } : undefined
}
await auth.set(c, "authorization", 60 * 60 * 24, authorization) // 24 hour TTL
```

### 2. Provider System Architecture

OpenAuth uses a plugin-based provider system where each provider implements:
- `/authorize` route - starts the auth flow  
- `/callback` route - handles the provider response
- Provider-specific state management
- Success callback integration

**Provider Interface**:
```typescript
interface Provider<T> {
  type: string
  init(routes: HonoRoutes, ctx: Context): void
}
```

### 3. Session & State Management

**Session Storage Pattern**:
- Uses `ctx.set(c, key, ttl, value)` for temporary state
- Uses `ctx.get(c, key)` for retrieval
- Session data has TTLs (typically 10-60 minutes)

**Authorization State Lifecycle**:
1. `/authorize` → create and store `AuthorizationState`
2. Provider flows → access stored state
3. `/token` → consume and remove state

## Provider Patterns Analysis

### Code Provider (Email/OTP)
**File**: `packages/openauth/src/provider/code.ts`

**State Machine**:
- `"start"` → user enters email/phone
- `"code"` → user enters verification code

**Key Features**:
- Timing-safe code comparison (`timingSafeCompare`)
- Configurable code length (default 6 digits)
- Resend functionality
- Custom UI via `request` callback

**Storage Pattern**:
```typescript
await ctx.set<CodeProviderState>(c, "provider", 60 * 60 * 24, {
  type: "code",
  code: generatedCode,
  claims: { email: "user@example.com" }
})
```

### OAuth2 Provider
**File**: `packages/openauth/src/provider/oauth2.ts`

**Flow**:
1. `/authorize` → redirect to external OAuth provider
2. `/callback` → exchange authorization code for tokens
3. Return tokenset to success handler

**Key Features**:
- PKCE support (`pkce: true` config option)
- Token exchange with proper error handling
- JWT verification for ID tokens
- State validation

### OIDC Provider  
**File**: `packages/openauth/src/provider/oidc.ts`

**Differences from OAuth2**:
- Uses `response_type: "id_token"` instead of `"code"`
- Uses `response_mode: "form_post"` 
- Validates nonce parameter
- Returns JWT payload directly

## Critical Dependencies

### Storage System
**File**: `packages/openauth/src/storage/storage.ts`
- Unified interface with `get`, `set`, `remove`, `scan`
- TTL support built-in
- Key encoding with separator character `0x1f`

### Key Management
**File**: `packages/openauth/src/keys.ts` 
- ES256 keys for JWT signing
- Automatic key rotation
- JWKS endpoint generation
- Multiple key support for graceful rotation

### Error Handling
**File**: `packages/openauth/src/error.ts`
- OAuth-compliant error responses
- Proper error codes and descriptions
- Redirect handling for errors

## Success Flow Integration

**Pattern**:
```typescript
return ctx.success(c, {
  // Provider-specific data that gets passed to success callback
  provider: "google",
  tokenset: { access_token: "...", ... },
  claims: { email: "...", ... }
})
```

The success callback receives this data and creates subjects:
```typescript
success: async (ctx, value) => {
  if (value.provider === "google") {
    const userId = lookupOrCreateUser(value.claims.email)
    return ctx.subject("user", userId, { email: value.claims.email })
  }
}
```

## Key Insights for ModularAuth

1. **State Management**: OpenAuth heavily relies on short-lived session storage for flow state
2. **Provider Isolation**: Each provider manages its own routes and state independently  
3. **Success Integration**: Providers call `ctx.success()` which triggers the main success callback
4. **Error Handling**: Comprehensive OAuth error responses with proper redirects
5. **Security**: PKCE, timing-safe comparisons, proper JWT validation
6. **Flexibility**: UI customization through callback functions

This analysis shows OpenAuth's proven patterns that ModularAuth should adopt while simplifying the architecture.