# 0003: Phase 3 - OAuth Providers (Google & GitHub)

## Context

**What was completed in Phase 1-2:**
- ✅ Core ModularAuth architecture working end-to-end
- ✅ OTP provider fully implemented and tested
- ✅ Storage implementations (Memory, DynamoDB, Redis)
- ✅ Provider system with dynamic routing (`/provider/authorize`, `/provider/callback`)

**What comes after Phase 3:**
Phase 4 will create the client library with automatic refresh, and Phase 5 will add React integration and final testing.

## Goal

Add OAuth 2.0 providers (Google, GitHub) that integrate seamlessly with the existing ModularAuth provider system. Follow OpenAuth's proven provider patterns but adapt to our modular architecture.

## Current Provider System

We already have:
- `Provider<TConfig, TUserData>` interface working
- `ProviderHandlers` with `authorize` and `callback` methods
- Provider registration and routing in ModularAuth class
- Complete OAuth flow: authorize → callback → token exchange → JWT issuance

## Tasks

### Task 1: Create OAuth2 Base Provider Class

**File to create**: `packages/modularauth/src/providers/oauth2-base.ts`

**Goal**: Abstract base class for OAuth 2.0 providers to reduce code duplication.

**Design approach**:
```typescript
export abstract class OAuth2Provider<TUserData> implements Provider<OAuth2Config, TUserData> {
  type = "oauth" as const
  
  // Abstract properties each provider must define
  abstract authorizationEndpoint: string
  abstract tokenEndpoint: string  
  abstract userInfoEndpoint: string
  abstract scopes: string[]

  // Concrete implementation shared by all OAuth providers
  init(): ProviderHandlers<TUserData> {
    return {
      authorize: (request) => this.handleAuthorize(request),
      callback: (request) => this.handleCallback(request)
    }
  }
  
  // Abstract method each provider implements differently
  abstract getUserInfo(accessToken: string): Promise<TUserData>
}
```

**Key requirements**:
1. Handle OAuth 2.0 authorization code flow
2. Support PKCE for security
3. State parameter validation  
4. Proper error handling with structured errors
5. Integration with ModularAuth's session storage

### Task 2: Implement Google Provider

**File to create**: `packages/modularauth/src/providers/google.ts`

**Reference**: `/Users/natac/code/forks/openauthjs/packages/openauth/src/provider/google.ts`

**Requirements**:
1. Extend `OAuth2Provider<GoogleUserData>`
2. Use Google's OAuth 2.0 endpoints
3. Request `email` and `profile` scopes by default
4. Handle Google's specific user info response format

**Google-specific configuration**:
```typescript
interface GoogleConfig {
  clientId: string
  clientSecret: string
  scopes?: string[]  // Default: ["email", "profile"]  
  redirectUri: string
}

interface GoogleUserData {
  id: string
  email: string
  name?: string
  picture?: string
  provider: "google"
}
```

### Task 3: Implement GitHub Provider

**File to create**: `packages/modularauth/src/providers/github.ts`

**Reference**: `/Users/natac/code/forks/openauthjs/packages/openauth/src/provider/github.ts`

**Requirements**:
1. Extend `OAuth2Provider<GitHubUserData>`
2. Use GitHub's OAuth endpoints
3. Handle GitHub's user API response format
4. Support GitHub's specific scopes (`user:email`)

**GitHub-specific considerations**:
- GitHub requires `User-Agent` header for API calls
- Email might be private (need separate API call)
- Different user info endpoint structure

### Task 4: Update Provider Registry and Exports

**Files to modify**:
- `packages/modularauth/src/providers/index.ts` - export new providers
- `packages/modularauth/src/index.ts` - export for users
- Update existing tests to include OAuth provider tests

## Implementation Strategy

### Follow OpenAuth Patterns, Not Innovation

**Copy these patterns exactly from OpenAuth**:
1. **Token exchange**: How OpenAuth exchanges authorization codes for access tokens
2. **User info fetching**: How OpenAuth calls provider APIs
3. **Error handling**: Use the same error types and messages
4. **State validation**: Copy OpenAuth's state parameter handling
5. **PKCE implementation**: Use OpenAuth's PKCE code generation and validation

**Don't invent new patterns**:
- Don't change OAuth flow steps
- Don't add custom provider features  
- Don't modify error response formats

### Integration Points

The OAuth providers integrate with existing ModularAuth systems:

1. **Authorization**: `GET /google/authorize` → redirect to Google
2. **Callback**: `GET /google/callback?code=...` → exchange code → store session
3. **Token exchange**: Session data flows to existing token endpoint
4. **JWT issuance**: Uses existing `onSuccess` callback pattern

### Testing Approach

**Unit tests**:
- Mock HTTP requests to provider endpoints
- Test user data transformation
- Test error handling scenarios

**Integration tests**:
- Complete OAuth flow with mocked responses
- Verify session storage and retrieval
- Test token issuance after OAuth success

## Example Usage

After Phase 3, users should be able to:

```typescript
import { createAuth, GoogleProvider, GitHubProvider } from '@modularauth/modularauth'

const auth = createAuth({
  providers: {
    google: new GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      redirectUri: 'http://localhost:3000/api/auth/google/callback'
    }),
    
    github: new GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,  
      redirectUri: 'http://localhost:3000/api/auth/github/callback'
    })
  },
  // ... rest of config
})
```

## Success Criteria

- [ ] Google OAuth flow works end-to-end
- [ ] GitHub OAuth flow works end-to-end  
- [ ] OAuth2Provider base class reduces code duplication
- [ ] Error handling matches OAuth 2.0 specifications
- [ ] User data properly typed and validated
- [ ] Integration with existing token issuance system
- [ ] Tests cover happy path and error scenarios
- [ ] No breaking changes to existing OTP provider

## Files to Create

### New Files
- `packages/modularauth/src/providers/oauth2-base.ts`
- `packages/modularauth/src/providers/google.ts`
- `packages/modularauth/src/providers/github.ts`
- `packages/modularauth/src/__tests__/google-provider.test.ts`
- `packages/modularauth/src/__tests__/github-provider.test.ts`

### Modified Files  
- `packages/modularauth/src/providers/index.ts`
- `packages/modularauth/src/index.ts`

## Time Estimate

**3-4 hours total**:
- OAuth2Provider base class: 1 hour
- Google provider implementation: 1 hour
- GitHub provider implementation: 1 hour  
- Testing and integration: 1-2 hours

## Key Implementation Notes

### Use Existing Infrastructure
- **Don't create new HTTP clients**: Use native `fetch()`
- **Don't create new session management**: Use existing storage patterns
- **Don't create new error types**: Use structured errors from Phase 1

### Security Considerations  
- **Validate state parameter**: Prevent CSRF attacks
- **Use PKCE**: Enhance security for public clients
- **Validate redirect URIs**: Prevent authorization code interception
- **Use timing-safe comparisons**: For security-sensitive string comparisons

### Error Handling
Use existing structured errors:
- `InvalidGrantError` for invalid authorization codes
- `MissingParameterError` for required parameters
- `OauthError` for provider-specific errors

This phase focuses on extending the proven provider system rather than rebuilding OAuth flows from scratch.