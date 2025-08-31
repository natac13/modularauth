# 0001: Phase 1 Completion - Core OAuth Flow + Email OTP

## Current State Assessment

✅ **What's Working**:

- Core types and interfaces defined in `packages/modularauth/src/core/types.ts`
- Key management system implemented following OpenAuth patterns
- Storage interface adopted from OpenAuth (`StorageAdapter`)
- Basic auth class structure in `ModularAuth` class
- Discovery endpoints (`.well-known/*`) working
- Test infrastructure and Hono demo app

❌ **What's Missing**:

- Authorization state storage and management
- Provider system integration and routing
- Authorization code exchange in token endpoint
- Email OTP provider implementation
- Complete OAuth authorization flow

## Step 1: Implement Authorization State Storage

### Goal

Handle authorization requests properly by storing state like OpenAuth does.

### Implementation

1. **Add Authorization State Types** to `types.ts`:

   ```typescript
   interface AuthorizationState {
     response_type: string
     client_id?: string
     redirect_uri: string
     state?: string
     code_challenge?: string
     code_challenge_method?: string
     provider: string
     created: number
     expires: number
   }
   ```

2. **Update `handleAuthorize()` in `auth.ts`**:

   - Generate authorization code (UUID)
   - Validate required parameters (`redirect_uri`, `client_id`, `response_type`)
   - Create and store `AuthorizationState` with 10-minute TTL
   - Route to provider: `return c.redirect(\`/\${provider}/authorize\`)`

3. **Testing**:
   ```bash
   curl "http://localhost:3000/api/auth/authorize?provider=email&redirect_uri=http://localhost:3000/callback&client_id=test&response_type=code&state=abc123"
   ```
   - Should store authorization state
   - Should redirect to `/email/authorize`

## Step 2: Create Email OTP Provider

### Goal

Build the simplest working provider following OpenAuth's CodeProvider pattern.

### Implementation

1. **Create `packages/modularauth/src/providers/email-otp.ts`** with improved verification storage:

   ```typescript
   // Improved verification storage + OpenAuth flow patterns
   import { generateUnbiasedDigits, timingSafeCompare } from '../utils/random.js'
   import { Storage } from '../storage/index.js'
   import type { StorageAdapter } from '../core/types.js'

   export interface EmailOTPConfig {
     sendCode: (claims: { email: string }, code: string) => Promise<void | { type: "invalid_claim"; key: string; value: string }>
     length?: number // Default: 6
     storage: StorageAdapter // Need access to storage
   }

   // Improved verification challenge storage
   interface VerificationChallenge {
     code: string
     type: "email_otp"
     target: string // email address
     created: number
     expires: number
     attempts: number
     maxAttempts: number
   }

   export class EmailOTPProvider implements Provider<EmailOTPConfig, { claims: { email: string } }> {
     type = "otp" as const
     private length: number

     constructor(private config: EmailOTPConfig) {
       this.length = config.length || 6
     }

     private generateCode(): string {
       return generateUnbiasedDigits(this.length)
     }

     private async storeVerification(email: string, code: string): Promise<void> {
       const challenge: VerificationChallenge = {
         code,
         type: "email_otp",
         target: email,
         created: Date.now(),
         expires: Date.now() + 10 * 60 * 1000, // 10 minutes
         attempts: 0,
         maxAttempts: 3
       }

       // Simple key structure: ["verification", type, target]
       await Storage.set(
         this.config.storage,
         ["verification", "email_otp", email],
         challenge,
         600 // 10 minute TTL
       )
     }

     private async getVerification(email: string): Promise<VerificationChallenge | null> {
       const challenge = await Storage.get<VerificationChallenge>(
         this.config.storage,
         ["verification", "email_otp", email]
       )

       // Check expiration
       if (!challenge || Date.now() > challenge.expires) {
         return null
       }

       return challenge
     }

     init(): ProviderHandlers<{ claims: { email: string } }> {
       return {
         // Use arrow functions to avoid bind()
         authorize: async (request: Request) => this.handleAuthorize(request),
         callback: async (request: Request) => this.handleCallback(request)
       }
     }
   }
   ```

2. **Implement State Machine** with proper verification storage and rate limiting:

   ```typescript
   private async handleAuthorize(request: Request): Promise<Response> {
     if (request.method === 'GET') {
       // Return form for email input (start state)
       return this.createResponse({ state: { type: "start" } })
     }
     
     if (request.method === 'POST') {
       const formData = await request.formData()
       const action = formData.get('action')?.toString()
       
       if (action === 'request') {
         const email = formData.get('email')?.toString()
         if (!email) {
           return this.createResponse({ 
             error: { type: "invalid_claim", key: "email", value: "" }
           }, 400)
         }
         
         // Check rate limiting - existing verification within 1 minute
         const existing = await this.getVerification(email)
         if (existing && Date.now() - existing.created < 60 * 1000) {
           return this.createResponse({ 
             error: { type: "rate_limited", description: "Wait 1 minute between requests" }
           }, 429)
         }
         
         const code = this.generateCode()
         const claims = { email }
         
         // Send the code
         const err = await this.config.sendCode(claims, code)
         if (err) {
           return this.createResponse({ error: err }, 400)
         }
         
         // Store verification challenge (replaces any existing one)
         await this.storeVerification(email, code)
         
         return this.createResponse({ 
           message: "Code sent",
           state: { type: "code", email } // Don't return actual code!
         })
       }
     }
   }

   private async handleCallback(request: Request): Promise<Response> {
     const formData = await request.formData() 
     const submittedCode = formData.get('code')?.toString()
     const email = formData.get('email')?.toString()
     
     if (!submittedCode || !email) {
       return this.createResponse({ error: "missing_parameters" }, 400)
     }
     
     // Get stored verification
     const verification = await this.getVerification(email)
     if (!verification) {
       return this.createResponse({ 
         error: { type: "invalid_code", description: "Code expired or not found" }
       }, 400)
     }
     
     // Check max attempts
     if (verification.attempts >= verification.maxAttempts) {
       await Storage.remove(this.config.storage, ["verification", "email_otp", email])
       return this.createResponse({ 
         error: { type: "max_attempts", description: "Too many attempts" }
       }, 400)
     }
     
     // Increment attempts
     verification.attempts += 1
     await Storage.set(
       this.config.storage, 
       ["verification", "email_otp", email], 
       verification, 
       Math.max(0, Math.floor((verification.expires - Date.now()) / 1000))
     )
     
     // Use OpenAuth's timing-safe comparison
     if (!timingSafeCompare(verification.code, submittedCode)) {
       return this.createResponse({ 
         error: { type: "invalid_code", attemptsLeft: verification.maxAttempts - verification.attempts }
       }, 400)
     }
     
     // Success! Clean up verification and return user data
     await Storage.remove(this.config.storage, ["verification", "email_otp", email])
     
     return this.createResponse({ 
       claims: { email }
     })
   }
   ```

3. **File-Based Testing**:

   ```typescript
   const provider = new EmailOTPProvider({
     async sendCode(email: string, code: string) {
       await Bun.write("./test-codes.json", JSON.stringify({ [email]: code }))
       console.log(`📧 Code for ${email}: ${code}`)
     },
   })
   ```

4. **Testing**:

   ```bash
   # Request code
   curl -X POST http://localhost:3000/api/auth/email/authorize \
     -H "Content-Type: application/json" \
     -d '{"email": "test@example.com"}'

   # Check file for code
   cat test-codes.json

   # Verify code
   curl -X POST http://localhost:3000/api/auth/email/callback \
     -H "Content-Type: application/json" \
     -d '{"email": "test@example.com", "code": "123456"}'
   ```

## Step 3: Provider Registration & Routing

### Goal

Integrate provider system into main auth class following OpenAuth patterns.

### Implementation

1. **Copy OpenAuth's random utilities exactly**:
   
   Create `packages/modularauth/src/utils/random.ts`:
   ```typescript
   // Copy EXACTLY from packages/openauth/src/random.ts - their version is better!
   import { timingSafeEqual } from "node:crypto"

   export function generateUnbiasedDigits(length: number): string {
     const result: number[] = []
     while (result.length < length) {
       const buffer = crypto.getRandomValues(new Uint8Array(length * 2))
       for (const byte of buffer) {
         if (byte < 250 && result.length < length) {
           result.push(byte % 10)
         }
       }
     }
     return result.join("")
   }

   export function timingSafeCompare(a: string, b: string): boolean {
     if (typeof a !== "string" || typeof b !== "string") {
       return false
     }
     if (a.length !== b.length) {
       return false
     }
     return timingSafeEqual(Buffer.from(a), Buffer.from(b))
   }
   ```

   **CRITICAL**: Create comprehensive tests for crypto utilities **before** potentially switching to Oslo later:
   ```typescript
   // packages/modularauth/src/__tests__/crypto.test.ts
   import { describe, it, expect } from 'vitest'
   import { generateUnbiasedDigits, timingSafeCompare } from '../utils/random.js'

   describe('Crypto Utilities', () => {
     describe('generateUnbiasedDigits', () => {
       it('should generate correct length', () => {
         expect(generateUnbiasedDigits(6)).toHaveLength(6)
         expect(generateUnbiasedDigits(4)).toHaveLength(4)
       })
       
       it('should only contain digits', () => {
         const code = generateUnbiasedDigits(100)
         expect(code).toMatch(/^\d+$/)
       })
       
       it('should be unbiased (no repeated patterns)', () => {
         const codes = Array.from({ length: 1000 }, () => generateUnbiasedDigits(6))
         const unique = new Set(codes)
         expect(unique.size).toBeGreaterThan(900) // Should be mostly unique
       })
     })
     
     describe('timingSafeCompare', () => {
       it('should return true for identical strings', () => {
         expect(timingSafeCompare('123456', '123456')).toBe(true)
       })
       
       it('should return false for different strings', () => {
         expect(timingSafeCompare('123456', '654321')).toBe(false)
       })
       
       it('should return false for different lengths', () => {
         expect(timingSafeCompare('123456', '1234')).toBe(false)
       })
     })
   })
   ```

2. **Provider Registration** in `ModularAuth` constructor:

   ```typescript
   private providers = new Map<string, ProviderHandlers>()

   constructor(config: AuthConfig<TProviders, TSubjects>) {
     // Set default TTLs
     this.config.ttl = {
       access: config.ttl?.access ?? 600,
       refresh: config.ttl?.refresh ?? 2592000,
     }
     
     // Register providers - THIS IS WHERE init() GETS CALLED
     for (const [name, provider] of Object.entries(config.providers)) {
       const handlers = provider.init()
       this.providers.set(name, handlers)
     }
   }
   ```

2. **Dynamic Routing** in `handler()` method:

   ```typescript
   // Add before existing endpoint checks
   const providerMatch = path.match(/^\/(\w+)\/(authorize|callback)$/)
   if (providerMatch) {
     const [, providerName, action] = providerMatch
     const provider = this.providers.get(providerName)
     if (!provider) return new Response("Unknown provider", { status: 404 })

     if (action === "authorize" && provider.authorize) {
       return provider.authorize(request)
     }
     if (action === "callback" && provider.callback) {
       return provider.callback(request)
     }
   }
   ```

3. **Update Hono Demo** to use EmailOTP provider:

   ```typescript
   import { EmailOTPProvider } from "@modularauth/modularauth/providers/email-otp"

   const auth = createAuth({
     providers: {
       email: new EmailOTPProvider({
         sendCode: async (email, code) => {
           await Bun.write("./codes.json", JSON.stringify({ [email]: code }))
           console.log(`📧 Code for ${email}: ${code}`)
         },
       }),
     },
     // ... rest of config
   })
   ```

4. **Testing**:
   - Email authorization: `GET /api/auth/email/authorize`
   - Email callback: `POST /api/auth/email/callback`
   - Provider routing working correctly

## Step 4: Authorization Code Exchange

### Goal

Complete OAuth flow by implementing proper token exchange in `handleToken()`.

### Implementation

1. **Update `handleToken()` for authorization_code grant**:

   ```typescript
   if (grantType === "authorization_code") {
     const code = form.get("code")?.toString()
     const redirectUri = form.get("redirect_uri")?.toString()

     // Get stored authorization state
     const authState = await Storage.get<AuthorizationState>(
       this.config.storage,
       ["oauth:authorization", code],
     )

     if (!authState || authState.expires < Date.now()) {
       return new Response(JSON.stringify({ error: "invalid_grant" }), {
         status: 400,
         headers: { "Content-Type": "application/json" },
       })
     }

     // Call provider to complete authentication
     const provider = this.providers.get(authState.provider)
     // ... get user data from provider callback

     // Call onSuccess to create subject
     const subject = await this.config.onSuccess(
       ctx,
       authState.provider,
       userData,
     )

     // Issue tokens
     const tokens = await this.issueTokens(subject)

     // Clean up authorization code
     await Storage.remove(this.config.storage, ["oauth:authorization", code])

     return new Response(JSON.stringify(tokens), {
       status: 200,
       headers: { "Content-Type": "application/json" },
     })
   }
   ```

2. **Integration with Provider Callbacks**:

   - Provider callbacks should store user data temporarily
   - Token endpoint retrieves and processes this data
   - Follows OpenAuth's success callback pattern

3. **End-to-End Testing**:

   ```bash
   # 1. Start authorization flow
   curl "http://localhost:3000/api/auth/authorize?provider=email&redirect_uri=http://localhost:3000/callback&client_id=test&response_type=code"

   # 2. Complete email OTP flow
   # (send email, get code from file)

   # 3. Exchange authorization code for tokens
   curl -X POST http://localhost:3000/api/auth/token \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d "grant_type=authorization_code&code=GENERATED_CODE&redirect_uri=http://localhost:3000/callback"

   # 4. Should receive access_token and refresh_token
   ```

## Step 5: Error Handling & OAuth Compliance

### Goal

Add proper OAuth error responses and request validation.

### Implementation

1. **OAuth Error Response Helper**:

   ```typescript
   private oauthError(error: string, description?: string, status = 400): Response {
     return new Response(
       JSON.stringify({
         error,
         error_description: description
       }),
       {
         status,
         headers: { "Content-Type": "application/json" }
       }
     )
   }
   ```

2. **Parameter Validation**:

   - Required parameters checking
   - `redirect_uri` format validation
   - Grant type validation
   - Client ID validation (if needed)

3. **Provider Error Handling**:

   - Timeout handling for OTP codes
   - Invalid code responses
   - Missing email validation

4. **Integration Tests**:

   ```typescript
   // packages/modularauth/src/__tests__/email-otp-flow.test.ts
   describe("Email OTP Complete Flow", () => {
     it("should complete full authorization code flow", async () => {
       // Test authorization → OTP → token exchange
     })

     it("should handle invalid codes", async () => {
       // Test error responses
     })
   })
   ```

## Success Criteria

**When Phase 1 is complete, you should have**:

✅ **Working Email OTP Flow**:

- Request authorization → get code → verify code → receive tokens
- All steps working end-to-end

✅ **Provider System**:

- Providers properly registered and routed
- Provider callbacks integrated with token issuance

✅ **OAuth Compliance**:

- Proper error responses with correct codes
- Authorization state management
- PKCE support (basic)

✅ **Testing**:

- Complete flow testable via curl/Postman
- Integration tests passing
- Demo app working

✅ **Code Quality**:

- No TypeScript errors
- Following OpenAuth patterns
- Clean separation of concerns

## Files to Create/Modify

### New Files:

- `packages/modularauth/src/utils/random.ts` (copy from OpenAuth)
- `packages/modularauth/src/providers/email-otp.ts`
- `packages/modularauth/src/providers/index.ts`
- `packages/modularauth/src/__tests__/crypto.test.ts` (CRITICAL for future Oslo migration)
- `packages/modularauth/src/__tests__/email-otp-flow.test.ts`

### Modified Files:

- `packages/modularauth/src/core/types.ts` (add AuthorizationState)
- `packages/modularauth/src/core/auth.ts` (provider integration, token exchange)
- `examples/hono-app/src/index.ts` (add EmailOTP provider)
