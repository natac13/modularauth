# ModularAuth Implementation Plan

This document provides detailed, step-by-step instructions for transforming OpenAuth into ModularAuth. Each phase builds on the previous one with clear checkpoints to verify progress.

## Overview

We're transforming a monolithic Hono server (OpenAuth) into a modular, request/response handler system (ModularAuth) with:

- OpenAuth's proven storage interface with user management via onSuccess
- Short-lived tokens with automatic refresh
- Context switching for dynamic data like workspaces
- Full type safety with no `any` types

## Phase 1: Extract Core Auth Logic (Days 0-3)

### Step 1: Create Core Types with Full Generics

```typescript
// packages/core/src/types.ts
import type { v1 } from "@standard-schema/spec"

// Provider types with generics
export interface Provider<TConfig = unknown, TUserData = unknown> {
  type: "oauth" | "otp" | "passkey"
  init(config: TConfig): ProviderHandlers<TUserData>
}

export interface ProviderHandlers<TUserData> {
  authorize?: (request: Request) => Promise<Response>
  callback?: (request: Request) => Promise<Response>
  getUserData?: (tokens: any) => Promise<TUserData>
}

// Subject types with inference
export type SubjectSchema = Record<string, v1.StandardSchema>

export type InferSubject<T extends SubjectSchema> = {
  [K in keyof T]: {
    type: K
    properties: v1.InferOutput<T[K]>
  }
}[keyof T]

// Use OpenAuth's proven StorageAdapter interface
export interface StorageAdapter {
  get(key: string[]): Promise<Record<string, any> | undefined>
  remove(key: string[]): Promise<void>
  set(key: string[], value: any, expiry?: Date): Promise<void>
  scan(prefix: string[]): AsyncIterable<[string[], any]>
}

// Configuration with simplified storage approach
export interface AuthConfig<
  TProviders extends Record<string, Provider>,
  TSubjects extends SubjectSchema,
> {
  issuer: string
  storage: StorageAdapter
  providers: TProviders
  subjects: TSubjects
  ttl?: {
    access?: number // Default: 10 minutes
    refresh?: number // Default: 30 days
  }

  onSuccess(
    ctx: SuccessContext<TSubjects>,
    provider: keyof TProviders,
    data: InferProviderData<TProviders[keyof TProviders]>,
  ): Promise<Subject>

  onRefresh?(subject: InferSubject<TSubjects>): Promise<InferSubject<TSubjects>>

  userInfo?(subject: InferSubject<TSubjects>): Promise<OIDCUserInfo>

  contextSwitch?: {
    enabled: boolean
    handler(
      subject: InferSubject<TSubjects>,
      context: any,
    ): Promise<InferSubject<TSubjects>>
  }
}
```

### Step 2: Extract Handler Logic from issuer.ts

```typescript
// packages/core/src/handlers/base.ts
export abstract class RequestHandler<TConfig = any> {
  constructor(protected config: TConfig) {}

  abstract match(method: string, path: string): boolean
  abstract handle(request: Request): Promise<Response>

  protected async jsonResponse(data: any, status = 200): Promise<Response> {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }
}

// packages/core/src/handlers/authorize.ts
import { RequestHandler } from "./base"

export class AuthorizeHandler extends RequestHandler {
  match(method: string, path: string): boolean {
    return method === "GET" && path === "/authorize"
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const params = url.searchParams

    // Extract from OpenAuth's issuer.ts lines 1007-1075
    const provider = params.get("provider")
    const response_type = params.get("response_type")
    const redirect_uri = params.get("redirect_uri")
    const state = params.get("state")
    const client_id = params.get("client_id")

    // Validation logic from OpenAuth
    if (!redirect_uri) {
      return new Response("Missing redirect_uri", { status: 400 })
    }

    // Store authorization state (adapt from OpenAuth)
    const authorization = {
      response_type,
      redirect_uri,
      state,
      client_id,
      // ... pkce handling
    }

    // Session storage using cookies (extract from OpenAuth)
    // ... implementation

    return this.redirect(`/${provider}/authorize`)
  }
}
```

### Step 3: Extract Token Handler with Refresh Logic

```typescript
// packages/core/src/handlers/token.ts
export class TokenHandler extends RequestHandler<AuthConfig> {
  match(method: string, path: string): boolean {
    return method === "POST" && path === "/token"
  }

  async handle(request: Request): Promise<Response> {
    const form = await request.formData()
    const grantType = form.get("grant_type")

    switch (grantType) {
      case "authorization_code":
        return this.handleAuthorizationCode(form)

      case "refresh_token":
        return this.handleRefreshToken(form)

      default:
        return this.jsonResponse({ error: "unsupported_grant_type" }, 400)
    }
  }

  private async handleRefreshToken(form: FormData): Promise<Response> {
    const refreshToken = form.get("refresh_token")?.toString()
    if (!refreshToken) {
      return this.jsonResponse({ error: "invalid_request" }, 400)
    }

    // Extract subject from refresh token using OpenAuth's storage pattern
    const tokenData = await Storage.get(this.config.storage, [
      "oauth:refresh",
      refreshToken,
    ])

    if (!tokenData) {
      return this.jsonResponse({ error: "invalid_grant" }, 400)
    }

    // Call onRefresh to get updated context
    let subject = tokenData.subject
    if (this.config.onRefresh) {
      subject = await this.config.onRefresh(subject)
    }

    // Issue new tokens with updated subject
    const tokens = await this.issueTokens(subject)

    return this.jsonResponse({
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      expires_in: tokens.expiresIn,
    })
  }
}
```

### Step 4: Create Context Switch Handler

```typescript
// packages/core/src/handlers/context-switch.ts
export class ContextSwitchHandler extends RequestHandler<AuthConfig> {
  match(method: string, path: string): boolean {
    return method === "POST" && path === "/switch-context"
  }

  async handle(request: Request): Promise<Response> {
    // Verify current token
    const auth = request.headers.get("Authorization")
    if (!auth?.startsWith("Bearer ")) {
      return this.jsonResponse({ error: "unauthorized" }, 401)
    }

    const token = auth.slice(7)
    const subject = await this.verifyToken(token)

    // Get new context from request
    const body = await request.json()

    // Call context switch handler
    if (!this.config.contextSwitch?.enabled) {
      return this.jsonResponse({ error: "not_implemented" }, 501)
    }

    const newSubject = await this.config.contextSwitch.handler(subject, body)

    // Issue new tokens immediately
    const tokens = await this.issueTokens(newSubject)

    return this.jsonResponse({
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      expires_in: tokens.expiresIn,
    })
  }
}
```

### Step 5: Create Main Auth Class

```typescript
// packages/core/src/auth.ts
export class ModularAuth<
  TProviders extends Record<string, Provider>,
  TSubjects extends SubjectSchema,
> {
  private handlers: RequestHandler[] = []

  constructor(private config: AuthConfig<TProviders, TSubjects>) {
    // Register core handlers
    this.handlers.push(
      new AuthorizeHandler(config),
      new TokenHandler(config),
      new UserInfoHandler(config),
      new JWKSHandler(config),
      new ContextSwitchHandler(config),
    )

    // Register provider handlers
    for (const [name, provider] of Object.entries(config.providers)) {
      const providerHandlers = provider.init(/* ... */)
      // ... register provider-specific routes
    }
  }

  async handler(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/api\/auth/, "")
    const method = request.method

    // Find matching handler
    for (const handler of this.handlers) {
      if (handler.match(method, path)) {
        return handler.handle(request)
      }
    }

    return new Response("Not found", { status: 404 })
  }
}

// Export factory function
export function createAuth<
  TProviders extends Record<string, Provider>,
  TSubjects extends SubjectSchema,
>(config: AuthConfig<TProviders, TSubjects>) {
  return new ModularAuth(config)
}
```

### 🧪 Phase 1 Tests

```typescript
// packages/core/tests/auth.test.ts
import { describe, it, expect } from "vitest"
import { createAuth } from "../src/auth"
import { MemoryAdapter } from "../src/adapters/memory"

describe("ModularAuth", () => {
  it("should handle request/response", async () => {
    const auth = createAuth({
      issuer: "https://example.com",
      storage: new MemoryStorage(),
      providers: {},
      subjects: {},
      onSuccess: async (ctx, provider, data) => {
        return ctx.subject("user", data.id, {
          userId: data.id,
          email: data.email,
        })
      },
    })

    const response = await auth.handler(
      new Request("https://example.com/.well-known/jwks.json"),
    )

    expect(response.status).toBe(200)
  })

  it("should enforce type safety", () => {
    // This should fail TypeScript compilation if any 'any' types exist
    // @ts-expect-error - testing type safety
    const auth = createAuth({
      storage: "not-a-storage", // Should error
    })
  })
})
```

### ✅ Phase 1 Checkpoint

- [ ] Core types defined with full generics
- [ ] Request handlers extracted from monolithic issuer.ts
- [ ] Context switch handler implemented
- [ ] Main auth class created
- [ ] Basic tests passing
- [ ] No TypeScript errors with strict mode

---

## Phase 2: Storage Implementation (Day 4)

### Step 1: Use OpenAuth's Storage Interface

```typescript
// packages/core/src/storage.ts
// Re-export OpenAuth's proven storage interface
export interface StorageAdapter {
  get(key: string[]): Promise<Record<string, any> | undefined>
  remove(key: string[]): Promise<void>
  set(key: string[], value: any, expiry?: Date): Promise<void>
  scan(prefix: string[]): AsyncIterable<[string[], any]>
}

// Re-export OpenAuth's storage utilities
export {
  Storage,
  joinKey,
  splitKey,
} from "../../openauth-original/src/storage/storage"
```

### Step 2: Create Storage Implementations

```typescript
// packages/core/src/storage/memory.ts
// Use OpenAuth's MemoryStorage directly
export { MemoryStorage } from "../../openauth-original/src/storage/memory"

// packages/core/src/storage/dynamo.ts
// Adapt OpenAuth's storage pattern for DynamoDB
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb"
import type { StorageAdapter } from "../storage"

export class DynamoStorage implements StorageAdapter {
  constructor(
    private client: DynamoDBClient,
    private tableName: string,
  ) {}

  async get(key: string[]): Promise<Record<string, any> | undefined> {
    const keyString = key.join("#")
    const result = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: keyString } },
      }),
    )

    if (!result.Item) return undefined

    return JSON.parse(result.Item.data.S!)
  }

  async set(key: string[], value: any, expiry?: Date): Promise<void> {
    const keyString = key.join("#")
    const item: any = {
      pk: { S: keyString },
      data: { S: JSON.stringify(value) },
    }

    if (expiry) {
      item.ttl = { N: String(Math.floor(expiry.getTime() / 1000)) }
    }

    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: item,
      }),
    )
  }

  async remove(key: string[]): Promise<void> {
    const keyString = key.join("#")
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: keyString } },
      }),
    )
  }

  async *scan(prefix: string[]): AsyncIterable<[string[], any]> {
    // Implementation for scanning with prefix
    // This would use DynamoDB's Query operation
    throw new Error("Not implemented - use Query operation for DynamoDB")
  }
}
```

### 🧪 Phase 2 Tests

```typescript
// packages/core/tests/storage.test.ts
describe("Storage Compliance", () => {
  const storages = [
    ["Memory", new MemoryStorage()],
    ["DynamoDB", new DynamoStorage(client, "auth-table")],
  ]

  for (const [name, storage] of storages) {
    describe(name, () => {
      it("should save and retrieve data", async () => {
        await storage.set(
          ["oauth:refresh", "user-1", "token-1"],
          { subject: { type: "user", properties: {} } },
          new Date(Date.now() + 3600000),
        )

        const retrieved = await storage.get([
          "oauth:refresh",
          "user-1",
          "token-1",
        ])
        expect(retrieved).toBeDefined()
      })

      it("should handle TTL expiry", async () => {
        await storage.set(
          ["test", "expired"],
          { data: "test" },
          new Date(Date.now() - 1000), // Already expired
        )

        // Should be expired (implementation dependent)
        const retrieved = await storage.get(["test", "expired"])
        // Result depends on storage implementation
      })
    })
  }
})
```

### ✅ Phase 2 Checkpoint

- [ ] OpenAuth's storage interface adopted
- [ ] Memory storage working
- [ ] DynamoDB storage implemented
- [ ] Storage compliance tests passing
- [ ] User management handled via onSuccess pattern

---

## Phase 3: Email/OTP Provider (Day 5)

### Step 1: Create Base Provider Class

```typescript
// packages/providers/src/base.ts
export abstract class BaseProvider<TConfig, TUserData>
  implements Provider<TConfig, TUserData>
{
  abstract type: "oauth" | "otp" | "passkey"

  constructor(protected config: TConfig) {}

  abstract init(): ProviderHandlers<TUserData>

  protected createResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }
}
```

### Step 2: Implement Email/OTP Provider

```typescript
// packages/providers/src/otp/email.ts
interface EmailOTPConfig {
  sendCode: (email: string, code: string) => Promise<void>
  codeLength?: number
  ttl?: number
}

interface EmailOTPUserData {
  id: string
  email: string
  provider: "email"
}

export class EmailOTPProvider extends BaseProvider<
  EmailOTPConfig,
  EmailOTPUserData
> {
  type = "otp" as const

  init(): ProviderHandlers<EmailOTPUserData> {
    return {
      authorize: async (request) => {
        const url = new URL(request.url)
        const email = url.searchParams.get("email")

        if (!email) {
          return this.createResponse({ error: "email_required" }, 400)
        }

        // Generate code
        const code = this.generateCode()

        // Store code with TTL
        await this.storeCode(email, code)

        // Send code
        await this.config.sendCode(email, code)

        return this.createResponse({ success: true })
      },

      callback: async (request) => {
        const body = await request.json()
        const { email, code } = body

        // Verify code
        const valid = await this.verifyCode(email, code)

        if (!valid) {
          return this.createResponse({ error: "invalid_code" }, 400)
        }

        // Return user data
        const userData: EmailOTPUserData = {
          id: email,
          email,
          provider: "email",
        }

        return this.createResponse({ user: userData })
      },
    }
  }

  private generateCode(): string {
    const length = this.config.codeLength || 6
    return Math.random()
      .toString()
      .slice(2, 2 + length)
      .padEnd(length, "0")
  }
}
```

### Step 3: Integrate with Auth System

```typescript
// packages/core/src/providers/registry.ts
export class ProviderRegistry {
  private providers = new Map<string, ProviderHandlers>()

  register(name: string, provider: Provider) {
    const handlers = provider.init()
    this.providers.set(name, handlers)
  }

  getHandlers(name: string): ProviderHandlers | undefined {
    return this.providers.get(name)
  }

  // Create routes for each provider
  createRoutes(): RequestHandler[] {
    const routes: RequestHandler[] = []

    for (const [name, handlers] of this.providers) {
      if (handlers.authorize) {
        routes.push(new ProviderRoute(`/${name}/authorize`, handlers.authorize))
      }

      if (handlers.callback) {
        routes.push(new ProviderRoute(`/${name}/callback`, handlers.callback))
      }
    }

    return routes
  }
}
```

### 🧪 Phase 3 Tests

```typescript
// packages/providers/tests/email-otp.test.ts
describe("EmailOTPProvider", () => {
  it("should send code and verify", async () => {
    const codes = new Map<string, string>()

    const provider = new EmailOTPProvider({
      sendCode: async (email, code) => {
        codes.set(email, code)
      },
      codeLength: 6,
      ttl: 600,
    })

    const handlers = provider.init()

    // Request code
    const authResponse = await handlers.authorize!(
      new Request("https://example.com?email=test@example.com"),
    )
    expect(authResponse.status).toBe(200)

    // Verify code
    const code = codes.get("test@example.com")!
    const callbackResponse = await handlers.callback!(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({ email: "test@example.com", code }),
      }),
    )

    const data = await callbackResponse.json()
    expect(data.user.email).toBe("test@example.com")
  })
})
```

### ✅ Phase 3 Checkpoint

- [ ] Base provider class created
- [ ] Email/OTP provider implemented
- [ ] Provider registry system working
- [ ] Can send and verify OTP codes
- [ ] Provider tests passing

---

## Phase 4: OAuth Providers (Day 6)

### Step 1: Extract OAuth2 Base from OpenAuth

```typescript
// packages/providers/src/oauth/base.ts
// Adapt from OpenAuth's oauth2.ts

export abstract class OAuth2Provider<TUserData> extends BaseProvider<
  OAuth2Config,
  TUserData
> {
  type = "oauth" as const

  abstract authorizationUrl: string
  abstract tokenUrl: string
  abstract userInfoUrl: string

  init(): ProviderHandlers<TUserData> {
    return {
      authorize: async (request) => {
        const url = new URL(this.authorizationUrl)
        url.searchParams.set("client_id", this.config.clientId)
        url.searchParams.set("redirect_uri", this.config.redirectUri)
        url.searchParams.set("scope", this.config.scopes.join(" "))
        url.searchParams.set("state", crypto.randomUUID())

        return Response.redirect(url.toString())
      },

      callback: async (request) => {
        const url = new URL(request.url)
        const code = url.searchParams.get("code")

        // Exchange code for tokens
        const tokens = await this.exchangeCode(code!)

        // Get user data
        const userData = await this.getUserData(tokens)

        return this.createResponse({ user: userData })
      },
    }
  }

  abstract getUserData(tokens: TokenSet): Promise<TUserData>
}
```

### Step 2: Implement Google Provider

```typescript
// packages/providers/src/oauth/google.ts
// Adapt from OpenAuth's provider/google.ts

interface GoogleUserData {
  id: string
  email: string
  name?: string
  picture?: string
  provider: "google"
}

export class GoogleProvider extends OAuth2Provider<GoogleUserData> {
  authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth"
  tokenUrl = "https://oauth2.googleapis.com/token"
  userInfoUrl = "https://www.googleapis.com/oauth2/v2/userinfo"

  async getUserData(tokens: TokenSet): Promise<GoogleUserData> {
    const response = await fetch(this.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    })

    const data = await response.json()

    return {
      id: data.id,
      email: data.email,
      name: data.name,
      picture: data.picture,
      provider: "google",
    }
  }
}
```

### Step 3: Implement GitHub Provider

```typescript
// packages/providers/src/oauth/github.ts
// Similar pattern, adapt from OpenAuth
```

### ✅ Phase 4 Checkpoint

- [ ] OAuth2 base class extracted
- [ ] Google provider working
- [ ] GitHub provider working
- [ ] Can complete full OAuth flow
- [ ] User data properly typed

---

## Phase 5: Passkey Provider (Day 7)

### Step 1: Implement WebAuthn Provider

```typescript
// packages/providers/src/passkey/index.ts
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server"

export class PasskeyProvider extends BaseProvider<
  PasskeyConfig,
  PasskeyUserData
> {
  type = "passkey" as const

  init(): ProviderHandlers<PasskeyUserData> {
    return {
      // Registration flow
      authorize: async (request) => {
        if (request.method === "POST") {
          // Verify registration
          const body = await request.json()
          const verification = await verifyRegistrationResponse({
            response: body,
            expectedChallenge: body.challenge,
            expectedOrigin: this.config.rpId,
          })

          if (verification.verified) {
            // Store credential
            await this.storeCredential(
              body.userId,
              verification.registrationInfo,
            )
          }

          return this.createResponse({ verified: verification.verified })
        }

        // Generate registration options
        const options = await generateRegistrationOptions({
          rpName: this.config.rpName,
          rpID: this.config.rpId,
          userID: crypto.randomUUID(),
          userName: request.headers.get("X-User-Email") || "user",
          attestationType: "none",
        })

        return this.createResponse(options)
      },

      // Authentication flow
      callback: async (request) => {
        const body = await request.json()

        // Get stored credential
        const credential = await this.getCredential(body.id)

        const verification = await verifyAuthenticationResponse({
          response: body,
          expectedChallenge: body.challenge,
          expectedOrigin: this.config.rpId,
          expectedRPID: this.config.rpId,
          authenticator: credential,
        })

        if (verification.verified) {
          return this.createResponse({
            user: {
              id: credential.userId,
              provider: "passkey",
            },
          })
        }

        return this.createResponse({ error: "verification_failed" }, 400)
      },
    }
  }
}
```

### ✅ Phase 5 Checkpoint

- [ ] Passkey registration flow working
- [ ] Passkey authentication flow working
- [ ] Credentials stored securely
- [ ] WebAuthn challenges properly validated

---

## Phase 6: Client Library (Day 8)

### Step 1: Create Client with Auto-Refresh

```typescript
// packages/client/src/client.ts
export class AuthClient {
  private accessToken?: string
  private refreshToken?: string
  private refreshTimer?: NodeJS.Timeout

  constructor(private config: ClientConfig) {}

  async verify(
    token: string,
    options?: { refresh?: string },
  ): Promise<VerifyResult> {
    try {
      // Try to verify access token
      const payload = await this.verifyJWT(token)

      return {
        subject: payload.subject,
        tokens: undefined,
      }
    } catch (error) {
      // If expired and refresh token provided, auto-refresh
      if (options?.refresh && error instanceof TokenExpiredError) {
        const refreshed = await this.refresh(options.refresh)

        if (!refreshed.err) {
          // Verify new access token
          const payload = await this.verifyJWT(refreshed.tokens!.access)

          return {
            subject: payload.subject,
            tokens: refreshed.tokens,
          }
        }
      }

      return { err: new InvalidAccessTokenError() }
    }
  }

  async switchContext(context: any): Promise<TokenResponse> {
    const response = await fetch(`${this.config.baseURL}/switch-context`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(context),
    })

    const data = await response.json()

    // Store new tokens
    this.setTokens(data.access_token, data.refresh_token)

    return {
      access: data.access_token,
      refresh: data.refresh_token,
    }
  }

  private setupAutoRefresh() {
    if (!this.config.autoRefresh) return

    // Decode token to get expiry
    const payload = this.decodeJWT(this.accessToken!)
    const expiresAt = payload.exp * 1000
    const refreshAt = expiresAt - (this.config.refreshBuffer || 60) * 1000

    const timeUntilRefresh = refreshAt - Date.now()

    if (timeUntilRefresh > 0) {
      this.refreshTimer = setTimeout(async () => {
        const refreshed = await this.refresh(this.refreshToken!)
        if (!refreshed.err) {
          this.setTokens(refreshed.tokens!.access, refreshed.tokens!.refresh)
        }
      }, timeUntilRefresh)
    }
  }
}
```

### 🧪 Phase 6 Tests

```typescript
describe("AuthClient", () => {
  it("should auto-refresh expired tokens", async () => {
    const client = new AuthClient({ baseURL: "http://localhost:3000" })

    // Mock expired token
    const expiredToken = createExpiredToken()
    const refreshToken = "valid-refresh"

    // Mock refresh endpoint
    fetchMock.post("/token", {
      access_token: "new-access",
      refresh_token: "new-refresh",
    })

    const result = await client.verify(expiredToken, { refresh: refreshToken })

    expect(result.err).toBeUndefined()
    expect(result.tokens).toBeDefined()
    expect(result.tokens!.access).toBe("new-access")
  })
})
```

### ✅ Phase 6 Checkpoint

- [ ] Client library created
- [ ] Auto-refresh working in verify()
- [ ] Context switching implemented
- [ ] Token storage and management
- [ ] Client tests passing

---

## Phase 7: React Integration (Day 9)

### Step 1: Create React Provider and Hooks

```typescript
// packages/react/src/provider.tsx
import { createContext, useContext, useState, useEffect } from 'react'
import type { AuthClient } from '@modularauth/client'

interface AuthContextValue {
  user: User | null
  loading: boolean
  signIn: {
    social: (provider: string) => Promise<void>
    email: (email: string) => Promise<void>
    passkey: () => Promise<void>
  }
  signOut: () => Promise<void>
  switchContext: (context: any) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({
  children,
  client
}: {
  children: React.ReactNode
  client: AuthClient
}) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Check for existing session
    client.getSession().then(session => {
      setUser(session?.user || null)
      setLoading(false)
    })
  }, [])

  const signIn = {
    social: async (provider: string) => {
      await client.signIn.social({ provider })
    },
    email: async (email: string) => {
      await client.signIn.email({ email })
    },
    passkey: async () => {
      await client.signIn.passkey()
    }
  }

  const signOut = async () => {
    await client.signOut()
    setUser(null)
  }

  const switchContext = async (context: any) => {
    await client.switchContext(context)
    // Refresh user data
    const session = await client.getSession()
    setUser(session?.user || null)
  }

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      signIn,
      signOut,
      switchContext
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
```

### ✅ Phase 7 Checkpoint

- [ ] React provider created
- [ ] useAuth hook working
- [ ] Session persistence
- [ ] Auto-refresh in React

---

## Phase 8: Integration Testing (Day 10)

### Step 1: Create Example App

```typescript
// examples/hono-app/src/index.ts
import { Hono } from "hono"
import { createAuth } from "@modularauth/core"
import { GoogleProvider, EmailOTPProvider } from "@modularauth/providers"
import { DynamoAdapter } from "@modularauth/adapters"

const app = new Hono()

const auth = createAuth({
  issuer: "http://localhost:3000",
  adapter: new DynamoAdapter(/* ... */),
  providers: {
    google: new GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    email: new EmailOTPProvider({
      sendCode: async (email, code) => {
        console.log(`Code for ${email}: ${code}`)
      },
    }),
  },
  subjects: {
    user: object({
      userId: string(),
      email: string(),
      workspaceId: optional(string()),
    }),
  },
  ttl: {
    access: 60 * 10, // 10 minutes
    refresh: 60 * 60 * 24 * 30, // 30 days
  },
  onSuccess: async (ctx, provider, data) => {
    // Implementation
  },
  onRefresh: async (subject, adapter) => {
    // Get fresh user data from your own database
    const user = await yourDB.getUser(subject.userId)
    return {
      ...subject,
      context: user.currentWorkspaceId
        ? {
            workspaceId: user.currentWorkspaceId,
            role: user.workspaces.find((w) => w.id === user.currentWorkspaceId)
              ?.role,
          }
        : undefined,
    }
  },
})

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  return auth.handler(c.req.raw)
})

export default app
```

### Step 2: End-to-End Tests

```typescript
// tests/e2e/auth-flow.test.ts
describe("Complete Auth Flow", () => {
  it("should handle email OTP flow", async () => {
    // 1. Request OTP
    const authResponse = await fetch(
      "/api/auth/email/authorize?email=test@example.com",
    )
    expect(authResponse.ok).toBe(true)

    // 2. Submit OTP
    const code = getLastEmailCode()
    const callbackResponse = await fetch("/api/auth/email/callback", {
      method: "POST",
      body: JSON.stringify({ email: "test@example.com", code }),
    })

    // 3. Get tokens
    const tokens = await callbackResponse.json()
    expect(tokens.access_token).toBeDefined()

    // 4. Verify token
    const verified = await client.verify(tokens.access_token)
    expect(verified.subject.properties.email).toBe("test@example.com")

    // 5. Switch workspace
    await client.switchContext({ workspaceId: "workspace-2" })

    // 6. Verify new context
    const session = await client.getSession()
    expect(session.user.context.workspaceId).toBe("workspace-2")
  })
})
```

### ✅ Phase 8 Final Checkpoint

- [ ] Example app running
- [ ] All providers working end-to-end
- [ ] Token refresh working automatically
- [ ] Context switching working
- [ ] No TypeScript errors
- [ ] All tests passing

---

## Migration Checklist

### From OpenAuth to ModularAuth

1. **Update imports**:

   ```typescript
   // Before
   import { issuer } from "@openauthjs/openauth"

   // After
   import { createAuth } from "@modularauth/core"
   ```

2. **Update configuration**:

   ```typescript
   // Before
   const app = issuer({
     storage: MemoryStorage(),
     // ...
   })

   // After
   const auth = createAuth({
     adapter: new MemoryAdapter(),
     // ...
   })
   ```

3. **Update token TTLs**:

   ```typescript
   // Before: 30 day access tokens
   ttl: {
     access: 60 * 60 * 24 * 30
   }

   // After: 10 minute access tokens
   ttl: {
     access: 60 * 10
   }
   ```

4. **Add onRefresh handler**:

   ```typescript
   onRefresh: async (subject, adapter) => {
     // Fetch current user state
   }
   ```

5. **Update client code**:

   ```typescript
   // Before
   const client = createClient({ issuer: "..." })

   // After
   const client = createAuthClient({
     baseURL: "/api/auth",
     autoRefresh: true,
   })
   ```

---

## Success Metrics

After completing all phases, verify:

1. **Type Safety**: `tsc --noEmit` passes with no errors
2. **Tests**: All test suites passing (unit, integration, e2e)
3. **Performance**: Token refresh < 100ms
4. **Bundle Size**: Client library < 20KB gzipped
5. **Documentation**: All public APIs documented

## Troubleshooting Guide

### Common Issues

1. **TypeScript errors with generics**

   - Ensure all type parameters are propagated
   - Use `satisfies` for better inference

2. **Token refresh loops**

   - Check refresh buffer timing
   - Ensure onRefresh doesn't throw

3. **Context not updating**

   - Verify adapter.users.switchWorkspace is atomic
   - Check client is using new tokens

4. **Provider not working**
   - Verify provider routes registered
   - Check provider handlers return Response

## Next Steps After Implementation

1. **Performance optimization**

   - Add caching layer to adapters
   - Optimize JWT verification

2. **Additional providers**

   - Apple Sign In
   - Microsoft/Azure AD
   - Custom SAML

3. **Advanced features**
   - Multi-factor authentication
   - Session management UI
   - Admin dashboard

This implementation plan provides a clear path from OpenAuth's monolithic structure to ModularAuth's composable architecture, with verification points at each phase to ensure progress is being made correctly.
