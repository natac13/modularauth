import type {
  AuthConfig,
  InferSubject,
  Provider,
  SubjectSchema,
  AuthorizationState,
  ProviderHandlers,
  SuccessContext,
} from "./types.js"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { Storage } from "../storage/index.js"
import { signingKeys, currentSigningKey } from "./keys.js"
import {
  MissingParameterError,
  MissingProviderError,
  UnsupportedResponseTypeError,
  UnsupportedGrantTypeError,
  InvalidGrantError,
  oauthErrorResponse,
} from "./errors.js"
import * as jose from "jose"

export class ModularAuth<
  TProviders extends Record<string, Provider>,
  TSubjects extends SubjectSchema,
> {
  private providers = new Map<string, ProviderHandlers>()

  constructor(private config: AuthConfig<TProviders, TSubjects>) {
    // Set default TTLs
    this.config.ttl = {
      access: config.ttl?.access ?? 600, // 10 minutes
      refresh: config.ttl?.refresh ?? 2592000, // 30 days
    }

    // Register providers - THIS IS WHERE init() GETS CALLED
    for (const [name, provider] of Object.entries(config.providers)) {
      // Provider is guaranteed to have init() method per the Provider interface
      const handlers = provider.init()
      this.providers.set(name, handlers)
    }
  }

  /**
   * Main request handler for all OAuth 2.0/OIDC endpoints.
   *
   * Routes requests to appropriate handlers based on path:
   * - Well-known endpoints (JWKS, discovery)
   * - Provider-specific routes (authorize, callback)
   * - Core OAuth endpoints (authorize, token, userinfo)
   *
   * @param request - The incoming HTTP request
   * @returns Response for the OAuth flow step
   */
  async handler(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const pathname = url.pathname

    // Extract path after /api/auth or whatever the base path is
    const pathMatch = pathname.match(/\/auth(.*)$/)
    if (!pathMatch) {
      return new Response("Not found", { status: 404 })
    }

    const path = pathMatch[1] || "/"

    // Handle well-known endpoints
    if (path === "/.well-known/jwks.json") {
      return this.handleJWKS()
    }

    if (path === "/.well-known/openid-configuration") {
      return this.handleDiscovery()
    }

    if (path === "/.well-known/oauth-authorization-server") {
      return this.handleOAuth2Discovery()
    }

    // Add provider routing before existing endpoint checks
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

    // Handle OAuth endpoints
    if (path === "/authorize" && request.method === "GET") {
      return this.handleAuthorize(request)
    }

    if (path === "/token" && request.method === "POST") {
      return this.handleToken(request)
    }

    // For now, return a simple response
    return new Response(
      JSON.stringify({
        message: "ModularAuth is running",
        path,
        method: request.method,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  /**
   * Handles the JWKS (JSON Web Key Set) endpoint.
   *
   * Returns public keys used to verify JWT signatures.
   * Clients use this to validate access tokens.
   *
   * @returns JSON response with public key set
   */
  private async handleJWKS(): Promise<Response> {
    // Get all signing keys from storage
    // This follows OpenAuth's pattern from issuer.ts
    const keys = await signingKeys(this.config.storage)

    // Return all public keys in JWKS format
    // Include expired keys for verification of old tokens
    const jwks = keys.map((k) => k.jwk)

    return new Response(JSON.stringify({ keys: jwks }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  private async handleDiscovery(): Promise<Response> {
    return new Response(
      JSON.stringify({
        issuer: this.config.issuer,
        authorization_endpoint: `${this.config.issuer}/authorize`,
        token_endpoint: `${this.config.issuer}/token`,
        userinfo_endpoint: `${this.config.issuer}/userinfo`,
        jwks_uri: `${this.config.issuer}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["ES256"],
        scopes_supported: ["openid", "email", "profile"],
        token_endpoint_auth_methods_supported: [
          "client_secret_post",
          "client_secret_basic",
        ],
        claims_supported: ["sub", "email", "name", "picture"],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  private async handleOAuth2Discovery(): Promise<Response> {
    // OAuth 2.0 Authorization Server Metadata (RFC 8414)
    // Similar to OIDC discovery but without userinfo endpoint
    return new Response(
      JSON.stringify({
        issuer: this.config.issuer,
        authorization_endpoint: `${this.config.issuer}/authorize`,
        token_endpoint: `${this.config.issuer}/token`,
        jwks_uri: `${this.config.issuer}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: [
          "client_secret_post",
          "client_secret_basic",
        ],
        revocation_endpoint: `${this.config.issuer}/revoke`,
        revocation_endpoint_auth_methods_supported: [
          "client_secret_post",
          "client_secret_basic",
        ],
        code_challenge_methods_supported: ["S256"],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  /**
   * Handles the OAuth 2.0 authorization endpoint.
   *
   * This is the entry point for the OAuth flow. It:
   * 1. Validates the authorization request parameters
   * 2. Generates a unique authorization code
   * 3. Stores the authorization state for later validation
   * 4. Redirects to the provider for authentication
   *
   * @param request - The authorization request
   * @returns Redirect to provider or error response
   */
  private async handleAuthorize(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const params = url.searchParams

    // Extract required parameters
    const provider = params.get("provider")
    const redirectUri = params.get("redirect_uri")
    const responseType = params.get("response_type")
    const clientId = params.get("client_id")
    const state = params.get("state")
    const codeChallenge = params.get("code_challenge")
    const codeChallengeMethod = params.get("code_challenge_method")

    // Validate required parameters
    if (!provider || !this.config.providers[provider]) {
      return oauthErrorResponse(new MissingProviderError())
    }

    if (!redirectUri) {
      return oauthErrorResponse(new MissingParameterError("redirect_uri"))
    }

    if (!responseType || responseType !== "code") {
      return oauthErrorResponse(new UnsupportedResponseTypeError(responseType || undefined))
    }

    // Generate authorization code
    const code = crypto.randomUUID()

    // Create authorization state
    const authState: AuthorizationState = {
      response_type: responseType,
      client_id: clientId || undefined,
      redirect_uri: redirectUri,
      state: state || undefined,
      code_challenge: codeChallenge || undefined,
      code_challenge_method: codeChallengeMethod || undefined,
      provider,
      created: Date.now(),
      expires: Date.now() + 10 * 60 * 1000, // 10 minutes
    }

    // Store authorization state with 10-minute TTL
    await Storage.set(
      this.config.storage,
      ["oauth:authorization", code],
      authState,
      600, // 10 minutes in seconds
    )

    // Route to provider authorization endpoint
    return Response.redirect(
      `${url.origin}/auth/${provider}/authorize?code=${code}`,
      302,
    )
  }

  /**
   * Handles the OAuth 2.0 token endpoint.
   *
   * Exchanges authorization codes for access/refresh tokens.
   * Supports grant types:
   * - authorization_code: Exchange code for tokens
   * - refresh_token: Exchange refresh token for new access token
   *
   * This is where provider authentication results are connected
   * to JWT token issuance through the stored provider result.
   *
   * @param request - The token exchange request
   * @returns JSON response with tokens or error
   */
  private async handleToken(request: Request): Promise<Response> {
    const form = await request.formData()
    const grantType = form.get("grant_type")

    if (grantType === "authorization_code") {
      const code = form.get("code")?.toString()
      const redirectUri = form.get("redirect_uri")?.toString()

      if (!code) {
        return oauthErrorResponse(new MissingParameterError("code"))
      }

      // Single lookup following OpenAuth pattern
      const sessionData = await Storage.get<{
        userData: any
        provider: string
        redirectURI: string
        clientID?: string
        state?: string
        pkce?: { codeChallenge?: string; codeChallengeMethod?: string }
        timestamp: number
      }>(this.config.storage, ["oauth:code", code])

      if (!sessionData) {
        return oauthErrorResponse(new InvalidGrantError("Invalid or expired authorization code"))
      }

      // Validate redirect_uri matches (CRITICAL security check)
      if (redirectUri && redirectUri !== sessionData.redirectURI) {
        return oauthErrorResponse(new InvalidGrantError("Redirect URI mismatch"))
      }

      // Age validation
      const maxAge = 60 * 1000 // 60 seconds like OpenAuth
      if (Date.now() - sessionData.timestamp > maxAge) {
        await Storage.remove(this.config.storage, ["oauth:code", code])
        return oauthErrorResponse(new InvalidGrantError("Authorization code expired"))
      }

      /**
       * Create success context for onSuccess callback.
       * This provides the subject() helper function with proper typing.
       */
      const ctx: SuccessContext<TSubjects> = {
        subject: <K extends keyof TSubjects>(
          type: K,
          _id: string,
          properties: StandardSchemaV1.InferOutput<TSubjects[K]>,
        ): InferSubject<TSubjects> =>
          ({
            type: type as string,
            properties,
          }) as InferSubject<TSubjects>,
      }

      /**
       * Call user's onSuccess callback to create the final subject.
       * This allows customization of user data storage and subject creation.
       */
      const subject = await this.config.onSuccess(
        ctx,
        sessionData.provider as keyof TProviders,
        sessionData.userData,
      )

      // Single cleanup
      await Storage.remove(this.config.storage, ["oauth:code", code])

      // Issue tokens
      const tokens = await this.issueTokens(subject)

      return new Response(JSON.stringify(tokens), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (grantType === "refresh_token") {
      return this.handleRefreshToken(form)
    }

    return oauthErrorResponse(new UnsupportedGrantTypeError(grantType?.toString()))
  }

  private async handleRefreshToken(form: FormData): Promise<Response> {
    const refreshToken = form.get("refresh_token")?.toString()

    if (!refreshToken) {
      return oauthErrorResponse(new MissingParameterError("refresh_token"))
    }

    // Get stored refresh token data
    const tokenData = await Storage.get<{ subject: InferSubject<TSubjects> }>(
      this.config.storage,
      ["oauth:refresh", refreshToken],
    )

    if (!tokenData) {
      return oauthErrorResponse(new InvalidGrantError("Invalid refresh token"))
    }

    // Call onRefresh if provided
    let subject = tokenData.subject
    if (this.config.onRefresh) {
      subject = await this.config.onRefresh(subject)
    }

    // Issue new tokens
    const tokens = await this.issueTokens(subject)

    return new Response(JSON.stringify(tokens), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }


  /**
   * Issues JWT access and refresh tokens for a subject.
   *
   * Creates signed JWTs using the current signing key from storage.
   * Access tokens are short-lived (10 minutes by default) for security.
   * Refresh tokens are long-lived (30 days by default) for convenience.
   *
   * @param subject - The authenticated subject with type and properties
   * @returns Object containing access_token, refresh_token, and metadata
   */
  private async issueTokens(subject: InferSubject<TSubjects>) {
    // Get the current signing key from storage
    // This follows OpenAuth's pattern - always use the latest key for signing
    const key = await currentSigningKey(this.config.storage)

    // Create access token
    // The 'sub' (subject identifier) should be extracted from properties
    const subjectId =
      typeof subject.properties === "object" &&
      subject.properties !== null &&
      "id" in subject.properties
        ? String(subject.properties.id)
        : "unknown"

    const accessToken = await new jose.SignJWT({
      sub: subjectId,
      ...subject,
    })
      .setProtectedHeader({ alg: key.alg, kid: key.id, typ: "JWT" })
      .setIssuedAt()
      .setIssuer(this.config.issuer)
      .setExpirationTime(`${this.config.ttl!.access}s`)
      .sign(key.private)

    // Create refresh token (simple random string for now)
    const refreshToken = crypto.randomUUID()

    // Store refresh token
    await Storage.set(
      this.config.storage,
      ["oauth:refresh", refreshToken],
      { subject },
      this.config.ttl!.refresh,
    )

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.ttl!.access,
      refresh_token: refreshToken,
    }
  }
}

export function createAuth<
  TProviders extends Record<string, Provider>,
  TSubjects extends SubjectSchema,
>(config: AuthConfig<TProviders, TSubjects>) {
  return new ModularAuth(config)
}
