import "dotenv/config";
import session from "express-session";
import cookieParser from "cookie-parser";
import { createApp } from "headroom";
import authRouter, { requireAuth } from "./auth.js";
import billingRouter, { requireActiveSubscription } from "./billing.js";
import * as tenantDb from "./tenant-db.js";

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  console.error("SESSION_SECRET environment variable is required");
  process.exit(1);
}

// Initialize database
await tenantDb.migrate();

// Create headroom app with cloud overrides
const { server, app } = createApp({
  // No static API key — each request uses the user's OAuth token
  linearApiKey: null,

  // Per-tenant API key resolution from session
  getApiKeyForRequest: async (req) => {
    if (!req.session?.userId) return null;
    const user = await tenantDb.getUser(req.session.userId);
    return user ? `Bearer ${user.linear_access_token}` : null;
  },

  // Add auth and billing middleware before routes
  beforeRoutes: (app) => {
    app.use(cookieParser());
    app.use(session({
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === "production",
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      },
    }));

    // Auth routes (login, callback, logout, me)
    app.use(authRouter);

    // Require auth on API routes
    app.use(requireAuth);

    // Billing routes (checkout, portal, status, webhook)
    app.use(billingRouter);

    // Require active subscription for API access
    app.use(requireActiveSubscription);
  },
});

server.listen(PORT, () => {
  console.log(`Headroom Cloud running on http://localhost:${PORT}`);
});
