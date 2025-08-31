import type { StandardSchemaV1 } from "@standard-schema/spec"

type StandardSchema = StandardSchemaV1
type InferOutput<T extends StandardSchema> = StandardSchemaV1.InferOutput<T>

// Storage interface - using OpenAuth's proven pattern
export interface StorageAdapter {
  get(key: string[]): Promise<Record<string, any> | undefined>
  remove(key: string[]): Promise<void>
  set(key: string[], value: any, expiry?: Date): Promise<void>
  scan(prefix: string[]): AsyncIterable<[string[], any]>
}

// Provider types
export interface Provider<TConfig = unknown, TUserData = unknown> {
  type: "oauth" | "otp" | "passkey"
  init(config?: TConfig): ProviderHandlers<TUserData>
}

export interface ProviderHandlers<TUserData = unknown> {
  authorize?: (request: Request) => Promise<Response>
  callback?: (request: Request) => Promise<Response>
  getUserData?: (tokens: any) => Promise<TUserData>
}

// Subject types with inference
export type SubjectSchema = Record<string, StandardSchema>

export type InferSubject<T extends SubjectSchema> = {
  [K in keyof T]: {
    type: K
    properties: InferOutput<T[K]>
  }
}[keyof T]

// Success context for onSuccess callback
export interface SuccessContext<TSubjects extends SubjectSchema> {
  subject<K extends keyof TSubjects>(
    type: K,
    id: string,
    properties: InferOutput<TSubjects[K]>
  ): InferSubject<TSubjects>
}

// Main configuration
export interface AuthConfig<
  TProviders extends Record<string, Provider>,
  TSubjects extends SubjectSchema,
> {
  issuer: string
  storage: StorageAdapter
  providers: TProviders
  subjects: TSubjects
  
  ttl?: {
    access?: number  // Default: 10 minutes (600 seconds)
    refresh?: number // Default: 30 days (2592000 seconds)
  }

  onSuccess(
    ctx: SuccessContext<TSubjects>,
    provider: keyof TProviders,
    data: any // Will be typed based on provider
  ): Promise<InferSubject<TSubjects>>

  onRefresh?(
    subject: InferSubject<TSubjects>
  ): Promise<InferSubject<TSubjects>>

  userInfo?(
    subject: InferSubject<TSubjects>
  ): Promise<Record<string, any>>

  contextSwitch?: {
    enabled: boolean
    handler(
      subject: InferSubject<TSubjects>,
      context: any
    ): Promise<InferSubject<TSubjects>>
  }
}

// JWT types
export interface JWTPayload {
  iss: string
  sub: string
  aud?: string | string[]
  exp: number
  iat: number
  nbf?: number
  jti?: string
  [key: string]: any
}

// Authorization state for OAuth flow
export interface AuthorizationState {
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

// Token response types
export interface TokenResponse {
  access_token: string
  token_type: "Bearer"
  expires_in: number
  refresh_token?: string
  scope?: string
}