import { Hono } from "hono"
import { cors } from "hono/cors"
import { serveStatic } from "hono/bun"
import { createAuth, MemoryStorage } from "@modularauth/modularauth"
import { OTPProvider } from "@modularauth/modularauth/providers/otp"
import { object, string, optional } from "valibot"
import * as fs from "fs/promises"

// Define subjects schema
const subjects = {
  user: object({
    userId: string(),
    email: string(),
    name: optional(string()),
  })
} as const

// Create Hono app
const app = new Hono()

// Add CORS middleware
app.use("*", cors())

// Serve static files
app.use("/", serveStatic({ root: "./public" }))

// Initialize auth with OTP provider
const storage = MemoryStorage()

const auth = createAuth({
  issuer: "http://localhost:3000",
  storage,
  providers: {
    otp: new OTPProvider({
      storage, // Pass storage to provider
      async sendCode(claims, code) {
        // For testing, write to a JSON file
        const codesFile = "./test-codes.json"
        let codes = {}
        try {
          const existing = await fs.readFile(codesFile, "utf-8")
          codes = JSON.parse(existing)
        } catch {
          // File doesn't exist yet
        }
        if (claims.email) {
          codes[claims.email] = code
        }
        await fs.writeFile(codesFile, JSON.stringify(codes, null, 2))
        console.log(`📧 Code for ${claims.email}: ${code}`)
      },
    }),
  },
  subjects,
  ttl: {
    access: 600, // 10 minutes
    refresh: 2592000, // 30 days
  },
  
  async onSuccess(ctx, provider, data) {
    // Handle OTP provider response
    if (provider === "otp" && data.claims) {
      const userId = crypto.randomUUID()
      return ctx.subject("user", userId, {
        userId,
        email: data.claims.email,
        name: undefined,
      })
    }
    
    // Default handling for other providers
    const userId = data.id || crypto.randomUUID()
    
    return ctx.subject("user", userId, {
      userId,
      email: data.email || `${userId}@example.com`,
      name: data.name,
    })
  },
  
  async onRefresh(subject) {
    // For testing, just return the same subject
    console.log("Refreshing token for:", subject)
    return subject
  },
  
  async userInfo(subject) {
    return {
      sub: subject.properties.userId,
      email: subject.properties.email,
      name: subject.properties.name,
    }
  },
})

// Mount auth handler
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  return auth.handler(c.req.raw)
})

// Add a test endpoint
app.get("/", (c) => {
  return c.json({
    message: "ModularAuth Hono Example",
    endpoints: {
      auth: "/api/auth",
      discovery: "/api/auth/.well-known/openid-configuration",
      jwks: "/api/auth/.well-known/jwks.json",
    }
  })
})

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok" })
})

const port = process.env.PORT || 3000
console.log(`🚀 ModularAuth server running on http://localhost:${port}`)
console.log(`📚 OpenID Discovery: http://localhost:${port}/api/auth/.well-known/openid-configuration`)

export default {
  port,
  fetch: app.fetch,
}