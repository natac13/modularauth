import { describe, it, expect } from 'vitest'
import { createAuth, MemoryStorage } from '../index.js'
import { OTPProvider } from '../providers/otp.js'
import { object, string } from 'valibot'

describe('OTP Provider OAuth Flow End-to-End', () => {
  it('should complete authorization code flow with OTP provider', async () => {
    // Store sent codes for verification
    const sentCodes = new Map<string, string>()

    const storage = MemoryStorage()
    const auth = createAuth({
      issuer: 'http://localhost:3000',
      storage,
      providers: {
        otp: new OTPProvider({
          storage,
          sendCode: async (claims, code) => {
            if (claims.email) {
              sentCodes.set(claims.email, code)
              console.log(`Test: Code ${code} sent to ${claims.email}`)
            }
          }
        })
      },
      subjects: {
        user: object({
          userId: string(),
          email: string()
        })
      },
      async onSuccess(ctx, provider, data) {
        const userId = crypto.randomUUID()
        return ctx.subject('user', userId, {
          userId,
          email: data.claims.email
        })
      }
    })

    // 1. Start authorization flow
    const authUrl = 'http://localhost:3000/auth/authorize?provider=otp&redirect_uri=http://localhost:3000/callback&client_id=test&response_type=code&state=abc123'
    const authResponse = await auth.handler(new Request(authUrl))

    expect(authResponse.status).toBe(302)
    const location = authResponse.headers.get('location')
    expect(location).toBeDefined()
    
    // Extract authorization code from the redirect
    const locationUrl = new URL(location!, 'http://localhost:3000')
    const pathMatch = locationUrl.pathname.match(/\/auth\/(\w+)\/authorize/)
    expect(pathMatch).toBeDefined()
    expect(pathMatch![1]).toBe('otp')
    
    // The authorization code should be in the query params
    const authCode = locationUrl.searchParams.get('code')
    expect(authCode).toBeDefined()

    // 2. Request OTP code
    const otpRequestForm = new FormData()
    otpRequestForm.set('action', 'request')
    otpRequestForm.set('email', 'test@example.com')

    const otpResponse = await auth.handler(new Request(`http://localhost:3000/auth/otp/authorize?code=${authCode}`, {
      method: 'POST',
      body: otpRequestForm
    }))

    expect(otpResponse.status).toBe(200)
    const otpResult = await otpResponse.json()
    expect(otpResult.message).toBe('Code sent')
    expect(otpResult.state?.email).toBe('test@example.com')
    
    // Check that code was sent
    const code = sentCodes.get('test@example.com')
    expect(code).toBeDefined()
    expect(code!.length).toBe(6) // Default OTP length

    // 3. Verify OTP code  
    const verifyForm = new FormData()
    verifyForm.set('email', 'test@example.com')
    verifyForm.set('code', code!)

    const verifyResponse = await auth.handler(new Request(`http://localhost:3000/auth/otp/callback?code=${authCode}`, {
      method: 'POST',
      body: verifyForm
    }))

    expect(verifyResponse.status).toBe(302)
    const callbackLocation = verifyResponse.headers.get('location')
    expect(callbackLocation).toBeDefined()
    
    // Parse the callback URL
    const callbackUrl = new URL(callbackLocation!)
    expect(callbackUrl.hostname).toBe('localhost')
    expect(callbackUrl.pathname).toBe('/callback')
    
    const returnedCode = callbackUrl.searchParams.get('code')
    expect(returnedCode).toBe(authCode)
    
    const returnedState = callbackUrl.searchParams.get('state')
    expect(returnedState).toBe('abc123')

    // 4. Exchange authorization code for tokens
    const tokenForm = new FormData()
    tokenForm.set('grant_type', 'authorization_code')
    tokenForm.set('code', authCode!)
    tokenForm.set('redirect_uri', 'http://localhost:3000/callback')

    const tokenResponse = await auth.handler(new Request('http://localhost:3000/auth/token', {
      method: 'POST',
      body: tokenForm
    }))

    expect(tokenResponse.status).toBe(200)
    const tokens = await tokenResponse.json()
    
    // Verify token structure
    expect(tokens.access_token).toBeDefined()
    expect(typeof tokens.access_token).toBe('string')
    expect(tokens.refresh_token).toBeDefined()
    expect(typeof tokens.refresh_token).toBe('string')
    expect(tokens.token_type).toBe('Bearer')
    expect(tokens.expires_in).toBe(600) // 10 minutes default

    // 5. Verify that the same code cannot be used twice
    const duplicateTokenResponse = await auth.handler(new Request('http://localhost:3000/auth/token', {
      method: 'POST',
      body: tokenForm
    }))

    expect(duplicateTokenResponse.status).toBe(400)
    const duplicateError = await duplicateTokenResponse.json()
    expect(duplicateError.error).toBeDefined()
  })

  it('should handle invalid OTP code correctly', async () => {
    const sentCodes = new Map<string, string>()

    const storage = MemoryStorage()
    const auth = createAuth({
      issuer: 'http://localhost:3000',
      storage,
      providers: {
        otp: new OTPProvider({
          storage,
          sendCode: async (claims, code) => {
            if (claims.email) {
              sentCodes.set(claims.email, code)
            }
          }
        })
      },
      subjects: {
        user: object({
          userId: string(),
          email: string()
        })
      },
      async onSuccess(ctx, provider, data) {
        const userId = crypto.randomUUID()
        return ctx.subject('user', userId, {
          userId,
          email: data.claims.email
        })
      }
    })

    // Start authorization flow
    const authResponse = await auth.handler(new Request(
      'http://localhost:3000/auth/authorize?provider=otp&redirect_uri=http://localhost:3000/callback&client_id=test&response_type=code'
    ))

    const location = authResponse.headers.get('location')!
    const authCode = new URL(location, 'http://localhost:3000').searchParams.get('code')!

    // Request OTP
    const otpRequestForm = new FormData()
    otpRequestForm.set('action', 'request')
    otpRequestForm.set('email', 'test@example.com')

    await auth.handler(new Request(`http://localhost:3000/auth/otp/authorize?code=${authCode}`, {
      method: 'POST',
      body: otpRequestForm
    }))

    // Try to verify with wrong code
    const verifyForm = new FormData()
    verifyForm.set('email', 'test@example.com')
    verifyForm.set('code', 'wrong123')

    const verifyResponse = await auth.handler(new Request(`http://localhost:3000/auth/otp/callback?code=${authCode}`, {
      method: 'POST',
      body: verifyForm
    }))

    expect(verifyResponse.status).toBe(400)
    const error = await verifyResponse.json()
    expect(error.error).toBeDefined()
    expect(error.error.type).toBe('invalid_code')
    expect(error.error.attemptsLeft).toBe(2) // 3 max attempts - 1 failed
  })

  it('should handle rate limiting for OTP requests', async () => {
    const storage = MemoryStorage()
    const auth = createAuth({
      issuer: 'http://localhost:3000',
      storage,
      providers: {
        otp: new OTPProvider({
          storage,
          sendCode: async () => {
            // Just track that it was called
          }
        })
      },
      subjects: {
        user: object({
          userId: string(),
          email: string()
        })
      },
      async onSuccess(ctx, provider, data) {
        const userId = crypto.randomUUID()
        return ctx.subject('user', userId, {
          userId,
          email: data.claims.email
        })
      }
    })

    // Start authorization flow
    const authResponse = await auth.handler(new Request(
      'http://localhost:3000/auth/authorize?provider=otp&redirect_uri=http://localhost:3000/callback&client_id=test&response_type=code'
    ))

    const location = authResponse.headers.get('location')!
    const authCode = new URL(location, 'http://localhost:3000').searchParams.get('code')!

    // First OTP request - should succeed
    const otpRequestForm = new FormData()
    otpRequestForm.set('action', 'request')
    otpRequestForm.set('email', 'test@example.com')

    const firstResponse = await auth.handler(new Request(`http://localhost:3000/auth/otp/authorize?code=${authCode}`, {
      method: 'POST',
      body: otpRequestForm
    }))

    expect(firstResponse.status).toBe(200)

    // Second OTP request immediately - should be rate limited
    const secondResponse = await auth.handler(new Request(`http://localhost:3000/auth/otp/authorize?code=${authCode}`, {
      method: 'POST',
      body: otpRequestForm
    }))

    expect(secondResponse.status).toBe(429)
    const error = await secondResponse.json()
    expect(error.error.type).toBe('rate_limited')
  })
})