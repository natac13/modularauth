import type { AuthConfig, InferSubject, Provider, SubjectSchema } from "./types.js"
import { Storage } from "../storage/index.js"
import { signingKeys, currentSigningKey } from "./keys.js"
import * as jose from "jose"

export class ModularAuth<
  TProviders extends Record<string, Provider>,
  TSubjects extends SubjectSchema,
> {
  constructor(private config: AuthConfig<TProviders, TSubjects>) {
    // Set default TTLs
    this.config.ttl = {
      access: config.ttl?.access ?? 600, // 10 minutes
      refresh: config.ttl?.refresh ?? 2592000, // 30 days
    }
  }

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
        method: request.method 
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    )
  }

  private async handleJWKS(): Promise<Response> {
    // Get all signing keys from storage
    // This follows OpenAuth's pattern from issuer.ts
    const keys = await signingKeys(this.config.storage)
    
    // Return all public keys in JWKS format
    // Include expired keys for verification of old tokens
    const jwks = keys.map(k => k.jwk)
    
    return new Response(
      JSON.stringify({ keys: jwks }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    )
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
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "email", "profile"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        claims_supported: ["sub", "email", "name", "picture"],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    )
  }

  private async handleAuthorize(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const provider = url.searchParams.get("provider")
    
    if (!provider || !this.config.providers[provider]) {
      return new Response("Invalid provider", { status: 400 })
    }
    
    // For now, return a simple message
    return new Response(
      JSON.stringify({ 
        message: "Authorization endpoint",
        provider 
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    )
  }

  private async handleToken(request: Request): Promise<Response> {
    const form = await request.formData()
    const grantType = form.get("grant_type")
    
    if (grantType === "refresh_token") {
      return this.handleRefreshToken(form)
    }
    
    // For now, return a simple message
    return new Response(
      JSON.stringify({ 
        message: "Token endpoint",
        grant_type: grantType 
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    )
  }

  private async handleRefreshToken(form: FormData): Promise<Response> {
    const refreshToken = form.get("refresh_token")?.toString()
    
    if (!refreshToken) {
      return new Response(
        JSON.stringify({ error: "invalid_request" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }
    
    // Get stored refresh token data
    const tokenData = await Storage.get<{ subject: InferSubject<TSubjects> }>(
      this.config.storage,
      ["oauth:refresh", refreshToken]
    )
    
    if (!tokenData) {
      return new Response(
        JSON.stringify({ error: "invalid_grant" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }
    
    // Call onRefresh if provided
    let subject = tokenData.subject
    if (this.config.onRefresh) {
      subject = await this.config.onRefresh(subject)
    }
    
    // Issue new tokens
    const tokens = await this.issueTokens(subject)
    
    return new Response(
      JSON.stringify(tokens),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    )
  }

  private async issueTokens(subject: InferSubject<TSubjects>) {
    // Get the current signing key from storage
    // This follows OpenAuth's pattern - always use the latest key for signing
    const key = await currentSigningKey(this.config.storage)
    
    // Create access token
    const accessToken = await new jose.SignJWT({
      sub: (subject as any).properties?.id || "unknown",
      ...subject,
    })
      .setProtectedHeader({ alg: key.alg, kid: key.id })
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
      this.config.ttl!.refresh
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