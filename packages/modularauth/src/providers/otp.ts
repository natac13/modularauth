import { generateUnbiasedDigits, timingSafeCompare } from "../utils/random.js"
import { Storage } from "../storage/index.js"
import type {
  StorageAdapter,
  Provider,
  ProviderHandlers,
  AuthorizationState,
} from "../core/types.js"

/**
 * Configuration for the OTP (One-Time Password) provider.
 *
 * This provider is generic and can support multiple delivery methods through
 * the sendCode callback. The callback receives claims (e.g., email, phone)
 * and determines how to deliver the OTP code.
 */
export interface OTPConfig {
  /**
   * Callback to send the OTP code to the user.
   *
   * @param claims - User identifiers (email, phone, etc.)
   * @param code - The generated OTP code to send
   * @returns Optional error if sending fails
   *
   * @example
   * ```typescript
   * async sendCode(claims, code) {
   *   if (claims.email) await sendEmail(claims.email, code)
   *   if (claims.phone) await sendSMS(claims.phone, code)
   * }
   * ```
   */
  sendCode: (
    claims: Record<string, string>,
    code: string,
  ) => Promise<void | { type: "invalid_claim"; key: string; value: string }>
  length?: number // Default: 6
  storage: StorageAdapter // Need access to storage
}

const PROVIDER_TYPE = "otp" as const

// Improved verification challenge storage
interface VerificationChallenge {
  code: string
  type: typeof PROVIDER_TYPE
  target: string // email address
  created: number
  expires: number
  attempts: number
  maxAttempts: number
}

/**
 * Generic OTP (One-Time Password) provider that supports multiple delivery methods.
 *
 * The sendCode callback determines how the OTP is delivered:
 * - Email: sendCode can send via SMTP
 * - SMS: sendCode can send via Twilio/AWS SNS
 * - WhatsApp: sendCode can send via WhatsApp API
 * - Any other delivery method through custom implementation
 *
 * @example
 * ```typescript
 * new OTPProvider({
 *   sendCode: async (claims, code) => {
 *     if (claims.email) await sendEmail(claims.email, code)
 *     if (claims.phone) await sendSMS(claims.phone, code)
 *   },
 *   storage: storageAdapter
 * })
 * ```
 */
export class OTPProvider
  implements Provider<OTPConfig, { claims: Record<string, string> }>
{
  type = PROVIDER_TYPE
  private length: number
  private config: OTPConfig

  constructor(config: OTPConfig) {
    this.config = config
    this.length = config.length || 6
  }

  private generateCode(): string {
    return generateUnbiasedDigits(this.length)
  }

  private async storeVerification(email: string, code: string): Promise<void> {
    const challenge: VerificationChallenge = {
      code,
      type: PROVIDER_TYPE,
      target: email,
      created: Date.now(),
      expires: Date.now() + 10 * 60 * 1000, // 10 minutes
      attempts: 0,
      maxAttempts: 3,
    }

    // Simple key structure: ["verification", type, target]
    await Storage.set(
      this.config.storage,
      ["verification", PROVIDER_TYPE, email],
      challenge,
      600, // 10 minute TTL
    )
  }

  private async getVerification(
    email: string,
  ): Promise<VerificationChallenge | null> {
    const challenge = await Storage.get<VerificationChallenge>(
      this.config.storage,
      ["verification", PROVIDER_TYPE, email],
    )

    // Check expiration
    if (!challenge || Date.now() > challenge.expires) {
      return null
    }

    return challenge
  }

  init(): ProviderHandlers<{ claims: Record<string, string> }> {
    return {
      // Use arrow functions to avoid bind()
      authorize: async (request: Request) => this.handleAuthorize(request),
      callback: async (request: Request) => this.handleCallback(request),
    }
  }

  /**
   * Handles the authorization step of the OTP flow.
   *
   * GET: Returns initial state for UI to render input form
   * POST: Processes OTP code request and sends code to user
   *
   * @param request - The incoming HTTP request
   * @returns Response with OTP request status or form state
   */
  private async handleAuthorize(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const authCode = url.searchParams.get("code") // Authorization code from main OAuth flow

    if (request.method === "GET") {
      // Return form for email input (start state)
      // Include authCode so UI can pass it back in callback
      return this.createResponse({
        state: { type: "start" },
        authCode, // Pass to UI for inclusion in form
      })
    }

    if (request.method === "POST") {
      const formData = await request.formData()
      const action = formData.get("action")?.toString()

      if (action === "request") {
        const email = formData.get("email")?.toString()
        if (!email) {
          return this.createResponse(
            {
              error: { type: "invalid_claim", key: "email", value: "" },
            },
            400,
          )
        }

        // Check rate limiting - existing verification within 1 minute
        const existing = await this.getVerification(email)
        if (existing && Date.now() - existing.created < 60 * 1000) {
          return this.createResponse(
            {
              error: {
                type: "rate_limited",
                description: "Wait 1 minute between requests",
              },
            },
            429,
          )
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
          state: { type: "code", email }, // Don't return actual code!
        })
      }
    }

    // Default response for unhandled cases
    return this.createResponse({ error: "Invalid request" }, 400)
  }

  /**
   * Handles OTP verification and completes the provider authentication.
   *
   * This is the critical integration point where provider success connects
   * to the OAuth token exchange flow. Upon successful verification, user data
   * is stored with the authorization code for later retrieval by the token endpoint.
   *
   * @param request - The incoming HTTP request with OTP verification
   * @returns Response with redirect to client or error
   */
  private async handleCallback(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const authCode = url.searchParams.get("code") // Authorization code from OAuth flow

    const formData = await request.formData()
    const submittedCode = formData.get("code")?.toString()
    const email = formData.get("email")?.toString()

    if (!submittedCode || !email) {
      return this.createResponse({ error: "missing_parameters" }, 400)
    }

    if (!authCode) {
      return this.createResponse({ error: "missing_authorization_code" }, 400)
    }

    // Get stored verification
    const verification = await this.getVerification(email)
    if (!verification) {
      return this.createResponse(
        {
          error: {
            type: "invalid_code",
            description: "Code expired or not found",
          },
        },
        400,
      )
    }

    // Check max attempts
    if (verification.attempts >= verification.maxAttempts) {
      await Storage.remove(this.config.storage, [
        "verification",
        "email_otp",
        email,
      ])
      return this.createResponse(
        {
          error: { type: "max_attempts", description: "Too many attempts" },
        },
        400,
      )
    }

    // Use OpenAuth's timing-safe comparison
    if (!timingSafeCompare(verification.code, submittedCode)) {
      // Increment attempts on failure
      verification.attempts += 1

      // Check if this was the last attempt
      if (verification.attempts >= verification.maxAttempts) {
        await Storage.remove(this.config.storage, [
          "verification",
          PROVIDER_TYPE,
          email,
        ])
        return this.createResponse(
          {
            error: { type: "max_attempts", description: "Too many attempts" },
          },
          400,
        )
      }

      // Save updated attempts count
      await Storage.set(
        this.config.storage,
        ["verification", PROVIDER_TYPE, email],
        verification,
        Math.max(0, Math.floor((verification.expires - Date.now()) / 1000)),
      )

      return this.createResponse(
        {
          error: {
            type: "invalid_code",
            attemptsLeft: verification.maxAttempts - verification.attempts,
          },
        },
        400,
      )
    }

    // Success! Get authorization state for storing complete session
    const authState = await Storage.get<AuthorizationState>(
      this.config.storage,
      ["oauth:authorization", authCode],
    )

    if (!authState) {
      return this.createResponse({ error: "invalid_authorization_state" }, 400)
    }

    /**
     * Store complete session data in single operation (OpenAuth pattern).
     * This includes both user data and authorization parameters together.
     */
    await Storage.set(
      this.config.storage,
      ["oauth:code", authCode], // Use OpenAuth's key pattern
      {
        // User data from provider
        userData: { claims: { email } },
        provider: PROVIDER_TYPE,

        // Authorization parameters (needed for token exchange)
        redirectURI: authState.redirect_uri,
        clientID: authState.client_id,
        state: authState.state,
        pkce: {
          codeChallenge: authState.code_challenge,
          codeChallengeMethod: authState.code_challenge_method,
        },

        timestamp: Date.now(),
      },
      60, // 60 second TTL like OpenAuth
    )

    // Clean up authorization state (no longer needed)
    await Storage.remove(this.config.storage, ["oauth:authorization", authCode])
    await Storage.remove(this.config.storage, [
      "verification",
      PROVIDER_TYPE,
      email,
    ])

    // Redirect to client with authorization code
    const redirectUrl = new URL(authState.redirect_uri)
    redirectUrl.searchParams.set("code", authCode)
    if (authState.state) {
      redirectUrl.searchParams.set("state", authState.state)
    }

    return Response.redirect(redirectUrl.toString(), 302)
  }

  private createResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }
}
