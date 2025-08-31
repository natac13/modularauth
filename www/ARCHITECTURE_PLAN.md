# ModularAuth: A Modern, Composable Authentication Library

## Executive Summary

ModularAuth is a fork and evolution of OpenAuth that provides OAuth 2.0/OIDC-compliant authentication with a focus on modularity, developer experience, and database flexibility. Unlike existing solutions, it:

- **Works at the request/response level**, not as a standalone server
- **Lets you manage your own database** through a structured adapter interface
- **Provides a BetterAuth-like client API** with framework-agnostic design
- **Supports modern auth methods** (OAuth providers, Passkeys, Email/OTP)
- **Runs anywhere** that supports Web Standards (Hono, TanStack Start, React Router v7, etc.)

## Why We're Building This

### Problems with Existing Solutions

1. **Clerk**: Vendor lock-in, manages users externally, costs scale quickly
2. **BetterAuth**: Forces SQL databases, uses cookies/sessions (not stateless JWT)
3. **OpenAuth**: Acts as a separate Hono server, complex redirect flows, limited modularity

### Our Solution

Take OpenAuth's solid OAuth 2.0 foundation and make it:
- More modular and composable
- Database agnostic with structured adapters
- Work at the request/response level
- Provide better developer experience with simpler client API

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Your Application                      │
├─────────────────────────────────────────────────────────┤
│                    ModularAuth Core                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   Handlers   │  │   Providers  │  │    Client    │  │
│  │  - authorize │  │  - Google    │  │  - signIn    │  │
│  │  - token     │  │  - GitHub    │  │  - signOut   │  │
│  │  - userinfo  │  │  - Passkey   │  │  - verify    │  │
│  │  - jwks      │  │  - Email/OTP │  │  - refresh   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
├─────────────────────────────────────────────────────────┤
│                    Database Adapter                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │    Tokens    │  │   Accounts   │  │    Users     │  │
│  │  - refresh   │  │  - passwords │  │  - findOrCreate│
│  │  - codes     │  │  - passkeys  │  │  - getInfo   │  │
│  │  - keys      │  │  - otp       │  │              │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
├─────────────────────────────────────────────────────────┤
│                   Your Database                           │
│         (DynamoDB, PostgreSQL, Redis, etc.)              │
└─────────────────────────────────────────────────────────┘
```

## Core API Design with Full Type Safety

### Server Setup

```typescript
import { createAuth } from '@modularauth/core'
import { GoogleProvider, GitHubProvider, PasskeyProvider, EmailOTPProvider } from '@modularauth/providers'
import { createDynamoAdapter } from './adapters/dynamo'
import { object, string, optional, literal, union } from 'valibot'

// Define your user type
interface User {
  id: string
  email: string
  name?: string
  currentWorkspaceId?: string
  status: 'active' | 'pending_billing' | 'suspended'
  workspaces: Array<{
    id: string
    role: 'owner' | 'admin' | 'member'
  }>
}

// Create your database adapter with proper types
const adapter = createDynamoAdapter<User>({
  table: 'auth-data',
  userTable: 'users'
})

// Define subjects schema for type inference
const subjects = {
  user: object({
    userId: string(),
    email: string(),
    status: union([
      literal('active'),
      literal('pending_billing'),
      literal('suspended')
    ]),
    // Context that can change dynamically
    context: optional(object({
      workspaceId: string(),
      role: union([literal('owner'), literal('admin'), literal('member')]),
      permissions: optional(array(string()))
    }))
  })
} as const

// Initialize auth instance with full type safety
const auth = createAuth<
  typeof providers,
  typeof subjects,
  User
>({
  // Database adapter - you control user management
  adapter,
  
  // OAuth 2.0 issuer configuration
  issuer: 'https://auth.myapp.com',
  
  // Providers configuration - fully typed
  providers: {
    google: GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      scopes: ['email', 'profile']
    }),
    
    github: GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      scopes: ['user:email']
    }),
    
    passkey: PasskeyProvider({
      rpName: 'My App',
      rpId: 'myapp.com'
    }),
    
    email: EmailOTPProvider({
      sendCode: async (email, code) => {
        // Your email sending logic
        await sendEmail(email, `Your code is: ${code}`)
      },
      codeLength: 6,
      ttl: 60 * 10 // 10 minutes
    })
  },
  
  // JWT subject shape with type inference
  subjects,
  
  // Token TTL configuration - short-lived for dynamic data
  ttl: {
    access: 60 * 10, // 10 minutes - short for dynamic context
    refresh: 60 * 60 * 24 * 30 // 30 days
  },
  
  // Handle successful authentication - fully typed
  onSuccess: async (ctx, provider, providerData) => {
    // providerData is typed based on the provider
    let user = await adapter.users.findUser({
      provider: provider,
      providerId: providerData.id
    })
    
    if (!user) {
      // New user signup flow
      user = await adapter.users.createUser({
        email: providerData.email,
        name: providerData.name,
        status: 'pending_billing', // Flag for billing flow
        workspaces: []
      })
    }
    
    // Return the subject for the JWT - type checked!
    return ctx.subject('user', user.id, {
      userId: user.id,
      email: user.email,
      status: user.status,
      context: user.currentWorkspaceId ? {
        workspaceId: user.currentWorkspaceId,
        role: user.workspaces.find(w => w.id === user.currentWorkspaceId)?.role || 'member'
      } : undefined
    })
  },
  
  // Called on automatic token refresh (every 10 mins)
  onRefresh: async (subject, adapter) => {
    // Get current state from database
    const user = await adapter.users.getUser(subject.userId)
    if (!user) throw new Error('User not found')
    
    // Return updated subject with current context
    return {
      ...subject,
      context: user.currentWorkspaceId ? {
        workspaceId: user.currentWorkspaceId,
        role: user.workspaces.find(w => w.id === user.currentWorkspaceId)?.role || 'member'
      } : undefined
    }
  },
  
  // Context switching for immediate updates
  contextSwitch: {
    enabled: true,
    async handler(currentSubject, newContext, adapter) {
      // Validate and switch workspace atomically
      const user = await adapter.users.switchWorkspace(
        currentSubject.userId,
        newContext.workspaceId
      )
      
      // Return new subject for immediate token reissue
      return {
        ...currentSubject,
        context: {
          workspaceId: user.currentWorkspaceId!,
          role: user.workspaces.find(w => w.id === user.currentWorkspaceId)?.role || 'member'
        }
      }
    }
  },
  
  // OIDC userInfo endpoint data
  userInfo: async (subject) => {
    const user = await adapter.users.getUser(subject.userId)
    return {
      sub: subject.userId,
      email: user.email,
      name: user.name,
      picture: user.avatar,
      // ... any other OIDC standard claims
    }
  }
})
```

### Framework Integration

```typescript
// Hono
import { Hono } from 'hono'

const app = new Hono()
app.on(['POST', 'GET'], '/api/auth/*', (c) => {
  return auth.handler(c.req.raw)
})

// TanStack Start
export const ServerRoute = createServerFileRoute('/api/auth/$').methods({
  GET: ({ request }) => auth.handler(request),
  POST: ({ request }) => auth.handler(request)
})

// Next.js App Router
export async function GET(request: Request) {
  return auth.handler(request)
}
export async function POST(request: Request) {
  return auth.handler(request)
}

// Express/Node.js
app.all('/api/auth/*', async (req, res) => {
  const response = await auth.handler(toWebRequest(req))
  sendWebResponse(response, res)
})
```

### Client Usage with Automatic Refresh

```typescript
import { createAuthClient } from '@modularauth/client'

const client = createAuthClient({
  baseURL: '/api/auth',
  // Enable automatic refresh before token expiry
  autoRefresh: true,
  refreshBuffer: 60 // Refresh 1 minute before expiry
})

// Social sign-in (redirect-based)
await client.signIn.social({ 
  provider: 'google',
  redirectTo: '/dashboard'
})

// Social sign-in with ID token (no redirect)
await client.signIn.social({
  provider: 'google',
  idToken: googleIdToken // from Google Sign-In SDK
})

// Email OTP sign-in
await client.signIn.email({
  email: 'user@example.com'
})
// Then verify the code
await client.signIn.verifyEmail({
  email: 'user@example.com',
  code: '123456'
})

// Passkey sign-in
await client.signIn.passkey({
  email: 'user@example.com' // optional, for account selection
})

// Get current session - automatically refreshes if needed
const session = await client.getSession()
if (session) {
  console.log(session.user)
  
  // Check if user needs billing
  if (session.user.status === 'pending_billing') {
    router.push('/onboarding/billing')
  }
}

// Switch workspace - immediate token reissue
await client.switchContext({
  workspaceId: 'workspace-123'
})
// New tokens issued with updated workspace context

// Sign out
await client.signOut()

// Verify token (for API routes) - auto-refresh built in
const verified = await client.verify(token, {
  refresh: refreshToken // optional, auto-refresh if expired
})
// If access token is expired and refresh token provided,
// automatically refreshes and returns new tokens
```

### React Integration

```typescript
import { AuthProvider, useAuth } from '@modularauth/react'

// Wrap your app
function App() {
  return (
    <AuthProvider client={client}>
      <YourApp />
    </AuthProvider>
  )
}

// Use in components
function Profile() {
  const { user, signIn, signOut, loading } = useAuth()
  
  if (loading) return <div>Loading...</div>
  
  if (!user) {
    return (
      <button onClick={() => signIn.social({ provider: 'google' })}>
        Sign in with Google
      </button>
    )
  }
  
  return (
    <div>
      <p>Welcome, {user.email}</p>
      <button onClick={signOut}>Sign out</button>
    </div>
  )
}
```

## Database Adapter Interface with Type Safety

```typescript
// Generic adapter interface with user type parameter
interface AuthAdapter<TUser extends Record<string, unknown> = Record<string, unknown>> {
  // OAuth token storage
  tokens: {
    saveRefreshToken(
      subject: string, 
      token: string, 
      data: {
        clientId: string
        type: string
        properties: any
        ttl: { access: number, refresh: number }
        nextToken: string
      },
      ttl: number
    ): Promise<void>
    
    getRefreshToken(
      subject: string,
      token: string
    ): Promise<RefreshTokenData | null>
    
    deleteRefreshToken(subject: string, token: string): Promise<void>
    invalidateAllTokens(subject: string): Promise<void>
  }
  
  // Authorization codes (temporary)
  codes: {
    saveCode(
      code: string,
      data: {
        subject: string
        clientId: string
        redirectUri: string
        pkce?: { challenge: string, method: string }
        type: string
        properties: any
        ttl: { access: number, refresh: number }
      },
      ttl: number
    ): Promise<void>
    
    getCode(code: string): Promise<CodeData | null>
    deleteCode(code: string): Promise<void>
  }
  
  // JWT signing keys (with rotation)
  keys: {
    getCurrentSigningKey(): Promise<SigningKey>
    getAllSigningKeys(): Promise<SigningKey[]>
    rotateSigningKey(): Promise<SigningKey>
    
    getEncryptionKey(): Promise<EncryptionKey>
  }
  
  // Provider-specific account data
  accounts: {
    // Password provider
    savePasswordHash(email: string, hash: string): Promise<void>
    getPasswordHash(email: string): Promise<string | null>
    
    // OTP provider
    saveOTPCode(
      email: string, 
      code: string, 
      ttl: number
    ): Promise<void>
    verifyOTPCode(email: string, code: string): Promise<boolean>
    
    // Passkey provider
    savePasskeyCredential(
      userId: string,
      credential: PasskeyCredential
    ): Promise<void>
    getPasskeyCredentials(userId: string): Promise<PasskeyCredential[]>
    getPasskeyCredential(credentialId: string): Promise<PasskeyCredential | null>
  }
  
  // User management (your domain) - fully typed
  users: {
    findUser(data: {
      provider: string
      providerId: string
    }): Promise<TUser | null>
    
    createUser(data: {
      email?: string
      name?: string
      avatar?: string
      status: string
      metadata?: Record<string, unknown>
    }): Promise<TUser>
    
    findOrCreateUser(data: {
      provider: string
      providerId: string
      email?: string
      name?: string
      avatar?: string
      metadata?: Record<string, unknown>
    }): Promise<TUser>
    
    getUser(userId: string): Promise<TUser | null>
    
    // For context switching
    switchWorkspace(
      userId: string,
      workspaceId: string
    ): Promise<TUser>
    
    // For OIDC userInfo endpoint
    getUserInfo(userId: string): Promise<OIDCUserInfo>
  }
}
```

## What We Keep from OpenAuth

### Core OAuth 2.0 Implementation
- ✅ Authorization code flow
- ✅ PKCE support for SPAs
- ✅ Token endpoint implementation
- ✅ JWT signing and verification
- ✅ Key rotation mechanism
- ✅ Well-known endpoints
- ✅ OIDC compliance

### Provider System
- ✅ Provider interface pattern
- ✅ OAuth2 base provider
- ✅ Arctic integration
- ✅ Existing provider implementations (adapt to new structure)

### Security Features
- ✅ Domain validation for redirect URIs
- ✅ Secure cookie handling
- ✅ Token refresh rotation
- ✅ Proper error types

### Standards Compliance
- ✅ OAuth 2.0 spec adherence
- ✅ OIDC discovery
- ✅ JWT standards

## What Changes from OpenAuth

### Architecture Changes

| OpenAuth | ModularAuth |
|----------|-------------|
| Standalone Hono server | Request/response handler |
| Generic KV storage | Structured database adapter with types |
| Monolithic issuer.ts (1150+ lines) | Modular handler system |
| JSX UI components | Client-side UI control |
| Complex redirect flows | Simple client API |
| Provider-specific UI | Unified auth flow |
| Long-lived access tokens (30d default) | Short-lived tokens (10m) with auto-refresh |
| No context switching | Built-in context switching endpoint |
| Manual refresh handling | Automatic refresh in verify() |
| Limited type inference | Full type safety with generics |

### Code Organization

```
OpenAuth Structure:              ModularAuth Structure:
packages/openauth/               packages/core/
├── src/                        ├── src/
│   ├── issuer.ts (1150 lines) │   ├── auth.ts (main class)
│   ├── client.ts               │   ├── handlers/
│   ├── provider/               │   │   ├── authorize.ts
│   │   └── *.ts                │   │   ├── token.ts
│   ├── storage/                │   │   ├── userinfo.ts
│   │   └── *.ts                │   │   └── well-known.ts
│   └── ui/                     │   ├── providers/
│       └── *.tsx               │   │   ├── base.ts
                                │   │   └── registry.ts
                                │   ├── adapters/
                                │   │   └── interface.ts
                                │   └── jwt/
                                │       ├── sign.ts
                                │       └── verify.ts
                                │
                                packages/providers/
                                ├── src/
                                │   ├── oauth/
                                │   ├── passkey/
                                │   └── otp/
                                │
                                packages/client/
                                ├── src/
                                │   ├── client.ts
                                │   └── types.ts
                                │
                                packages/react/
                                └── src/
                                    ├── provider.tsx
                                    └── hooks.ts
```

### New Modular Handler System with Auto-Refresh

```typescript
// Instead of monolithic issuer, compose handlers
class ModularAuth<
  TProviders extends Record<string, Provider>,
  TSubjects extends SubjectSchema,
  TUser extends Record<string, unknown>
> {
  private handlers: Map<string, RequestHandler>
  
  constructor(config: AuthConfig<TProviders, TSubjects, TUser>) {
    this.handlers = new Map([
      ['GET /authorize', new AuthorizeHandler(config)],
      ['POST /token', new TokenHandler(config)],
      ['GET /userinfo', new UserInfoHandler(config)],
      ['GET /.well-known/jwks.json', new JWKSHandler(config)],
      ['POST /switch-context', new ContextSwitchHandler(config)],
      // Provider-specific routes
      ...this.createProviderHandlers(config.providers)
    ])
  }
  
  async handler(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace('/api/auth', '')
    const key = `${request.method} ${path}`
    
    const handler = this.matchHandler(key)
    if (!handler) {
      return new Response('Not found', { status: 404 })
    }
    
    return handler.handle(request)
  }
}

// Token handler with automatic refresh logic
class TokenHandler {
  async handle(request: Request): Promise<Response> {
    const form = await request.formData()
    const grantType = form.get('grant_type')
    
    if (grantType === 'refresh_token') {
      // Get current user state for dynamic context
      const subject = await this.decodeRefreshToken(form.get('refresh_token'))
      
      // Call onRefresh to get updated context
      const updatedSubject = await this.config.onRefresh(subject, this.adapter)
      
      // Issue new tokens with updated context
      return this.issueTokens(updatedSubject)
    }
    
    // ... handle other grant types
  }
}
```

### Simplified Provider Implementation

```typescript
// Old OpenAuth provider
export function GoogleProvider(config) {
  return {
    type: 'oauth',
    init(route, auth) {
      route.get('/authorize', async (c) => {
        // Complex Hono-specific implementation
      })
      route.get('/callback', async (c) => {
        // More Hono-specific code
      })
    }
  }
}

// New ModularAuth provider
export class GoogleProvider extends OAuthProvider {
  constructor(config: GoogleConfig) {
    super({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
      ...config
    })
  }
  
  async getUserData(tokens: TokenSet): Promise<ProviderUser> {
    const response = await fetch(this.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    })
    const data = await response.json()
    
    return {
      id: data.id,
      email: data.email,
      name: data.name,
      avatar: data.picture
    }
  }
}
```

## Implementation Phases

### Phase 1: Core Architecture (Week 1)
1. Fork OpenAuth repository
2. Refactor monolithic issuer.ts into modular handlers
3. Create structured database adapter interface
4. Implement request/response handler pattern
5. Set up monorepo structure with separate packages

### Phase 2: Provider Implementation (Week 2)
1. Implement Email/OTP provider
2. Adapt Google OAuth provider
3. Adapt GitHub OAuth provider
4. Implement Passkey provider with WebAuthn

### Phase 3: Client Library (Week 3)
1. Create framework-agnostic client
2. Implement signIn methods for each provider
3. Add session management
4. Create React hooks and provider

### Phase 4: Database Adapters (Week 4)
1. Create DynamoDB adapter
2. Create in-memory adapter for testing
3. Document adapter interface for community contributions
4. Add adapter testing suite

### Phase 5: Testing & Documentation (Week 5)
1. Comprehensive testing suite
2. API documentation
3. Migration guide from OpenAuth
4. Example applications

## File Structure After Refactoring

```
modularauth/
├── packages/
│   ├── core/                    # Main auth library
│   │   ├── src/
│   │   │   ├── auth.ts          # Main ModularAuth class
│   │   │   ├── handlers/        # Request handlers
│   │   │   ├── jwt/             # JWT utilities
│   │   │   ├── types.ts         # Core types
│   │   │   └── utils.ts         # Utilities
│   │   └── package.json
│   │
│   ├── providers/               # Provider implementations
│   │   ├── src/
│   │   │   ├── base.ts          # Base provider classes
│   │   │   ├── oauth/           # OAuth providers
│   │   │   │   ├── google.ts
│   │   │   │   ├── github.ts
│   │   │   │   └── oauth2.ts
│   │   │   ├── passkey/         # WebAuthn implementation
│   │   │   └── otp/             # Email/SMS OTP
│   │   └── package.json
│   │
│   ├── client/                  # Client library
│   │   ├── src/
│   │   │   ├── client.ts
│   │   │   ├── types.ts
│   │   │   └── utils.ts
│   │   └── package.json
│   │
│   ├── react/                   # React integration
│   │   ├── src/
│   │   │   ├── provider.tsx
│   │   │   ├── hooks.ts
│   │   │   └── types.ts
│   │   └── package.json
│   │
│   └── adapters/                # Database adapters
│       ├── dynamo/
│       ├── memory/
│       └── types.ts
│
├── examples/                    # Example applications
│   ├── hono-app/
│   ├── nextjs-app/
│   └── react-spa/
│
├── docs/                        # Documentation
│   ├── getting-started.md
│   ├── providers.md
│   ├── adapters.md
│   └── migration.md
│
└── README.md
```

## Automatic Refresh Pattern

The library handles token refresh automatically in two ways:

### 1. Client-Side Auto-Refresh
```typescript
// Client automatically refreshes before expiry
const client = createAuthClient({
  autoRefresh: true,
  refreshBuffer: 60 // Refresh 1 min before expiry
})

// These methods automatically handle refresh:
await client.getSession() // Refreshes if needed
await client.verify(token, { refresh }) // Auto-refreshes expired tokens
```

### 2. Server-Side Verify with Refresh
```typescript
// Just like OpenAuth, verify can auto-refresh
const verified = await client.verify(accessToken, {
  refresh: refreshToken // If provided, auto-refreshes on expiry
})

if (verified.tokens) {
  // New tokens were issued, update cookies/storage
  setCookie('access_token', verified.tokens.access)
  setCookie('refresh_token', verified.tokens.refresh)
}

// Use the verified subject
console.log(verified.subject.properties)
```

This matches OpenAuth's pattern where `verify()` handles refresh automatically when a refresh token is provided, making it seamless for SSR applications.

## Key Benefits of Our Approach

1. **Modularity**: Each component can be used independently
2. **Database Freedom**: Use any database through adapters
3. **Framework Agnostic**: Works with any Web Standards framework
4. **Type Safety**: Full TypeScript with generics, no `any` types
5. **Standards Compliant**: OAuth 2.0/OIDC compliant
6. **Developer Experience**: Simple, intuitive API with auto-refresh
7. **No Vendor Lock-in**: Self-hosted, your data, your control
8. **Dynamic Context**: Support for workspace switching without re-login
9. **Automatic Token Management**: Built-in refresh handling

## Success Criteria

- [ ] Can integrate with any Web Standards framework in < 5 minutes
- [ ] Database adapter implementation takes < 1 hour
- [ ] Client API is simpler than BetterAuth's
- [ ] Maintains OAuth 2.0/OIDC compliance
- [ ] Works with Lambda Authorizers out of the box
- [ ] TypeScript inference works throughout
- [ ] Can support all target providers (Google, GitHub, Passkeys, Email/OTP)

## Next Steps

1. Review and approve this plan
2. Set up the monorepo structure
3. Begin Phase 1 implementation
4. Create proof-of-concept with Email/OTP provider
5. Iterate based on real usage

This architecture gives us OpenAuth's solid foundation with the modularity and developer experience we need, without the limitations of existing solutions.