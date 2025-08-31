# ModularAuth Project

## What We're Building

**ModularAuth**: Take OpenAuth's proven OAuth 2.0/OIDC logic and make it framework-agnostic and composable.

**Core Principle**: Copy OpenAuth's battle-tested security and compliance patterns, but remove framework limitations and improve architecture where justified.

## What We Love About OpenAuth (KEEP)

- ✅ **OAuth 2.0/OIDC compliance**: Proven, secure, standards-compliant
- ✅ **JWT token management**: ES256, key rotation, proper JWKS endpoints
- ✅ **Storage interface**: Clean `StorageAdapter` pattern with `get/set/remove/scan`
- ✅ **Provider system**: Modular OAuth/OTP/Passkey provider architecture
- ✅ **Security patterns**: Timing-safe comparisons, PKCE, proper error handling
- ✅ **Edge compatibility**: Uses `aws4fetch` instead of AWS SDK

## What We Don't Like About OpenAuth (CHANGE)

- ❌ **Forced Hono server**: Can't use in Next.js, Express, TanStack Start, etc.
- ❌ **Built-in UI components**: We want headless/API-only for frontend flexibility
- ❌ **Cookie-based sessions**: OTP verification should be database-based for distributed systems
- ❌ **Monolithic structure**: Hard to customize, test, and extend individual components
- ❌ **Missing OIDC compliance**: JWTs missing `aud` field and other OIDC requirements

## Our Justified Changes

1. **Framework-agnostic**: Request/Response handlers instead of Hono server
2. **Database-based sessions**: Store OTP/auth state in storage, not cookies
3. **Modular architecture**: Composable providers and handlers for better testing
4. **OIDC compliance**: Add missing fields (`aud`, proper claims) for services like Convex
5. **Improved type safety**: Better generics and structured errors (no magic strings)

## Implementation Strategy

**"Boring" Approach**: Copy OpenAuth's proven patterns exactly where possible
- **Copy line-by-line**: Key management, storage patterns, crypto utilities, OAuth flows
- **Same dependencies**: Use `aws4fetch`, `jose`, same algorithms (ES256)
- **Same interfaces**: `StorageAdapter`, error types, JWT structure
- **Only change architecture**: Request/response instead of server, modular instead of monolithic

## Success Criteria

- ✅ **Framework flexibility**: Works in Next.js, Hono, Express, edge runtimes
- ✅ **API familiarity**: Similar developer experience to OpenAuth
- ✅ **Security maintained**: All OpenAuth security patterns preserved
- ✅ **OIDC ready**: JWTs work with services requiring OIDC compliance
- ✅ **Battle-tested**: Critical paths covered with focused testing

## Development Rules

- **use bun** for package manager and commands
- **do not modify** `@packages/openauth/` codebase
- **copy from OpenAuth** when implementing storage, providers, crypto
- **test critical paths** not implementation details
- **focus on security** and OAuth compliance over convenience features

Keep in mind the `@IMPLEMENTATION.md` plan and `@ARCHITECTURE_PLAN.md` plan. As well as `@plans/`
