import { Hono } from "hono"
import { cors } from "hono/cors"
import { serveStatic } from "hono/bun"
import { createAuth, MemoryStorage } from "@modularauth/core"
import { object, string, optional } from "valibot"

// Define user type (will be used when we add providers)
// interface User {
//   id: string
//   email: string
//   name?: string
// }

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

// Initialize auth
const auth = createAuth({
  issuer: "http://localhost:3000",
  storage: MemoryStorage(),
  providers: {
    // We'll add providers later
  },
  subjects,
  ttl: {
    access: 600, // 10 minutes
    refresh: 2592000, // 30 days
  },
  
  async onSuccess(ctx, _provider, data) {
    // For now, just create a simple user
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