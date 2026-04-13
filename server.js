import "dotenv/config";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createApp } from "cyclec";
import authRouter, { requireAuth, refreshLinearToken } from "./auth.js";
import billingRouter, { requireActiveSubscription } from "./billing.js";
import * as tenantDb from "./tenant-db.js";

const PgSession = connectPgSimple(session);

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

  // Per-tenant API key resolution from session, with auto-refresh
  getApiKeyForRequest: async (req) => {
    if (!req.session?.userId) return null;
    const user = await tenantDb.getUser(req.session.userId);
    if (!user) return null;
    return `Bearer ${user.linear_access_token}`;
  },

  // Called when Linear returns 401 — try refreshing the token
  onLinearAuthError: async (req) => {
    if (!req.session?.userId) return null;
    const newToken = await refreshLinearToken(req.session.userId);
    return newToken ? `Bearer ${newToken}` : null;
  },

  // Add auth and billing middleware before routes
  beforeRoutes: (app) => {
    // Security headers
    app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "ws:", "wss:"],
          upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
        },
      },
    }));

    // Rate limiting on auth endpoints
    app.use("/auth/", rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
    }));

    // Rate limiting on billing endpoints
    app.use("/api/billing/", rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
    }));

    app.use(cookieParser());
    app.use(session({
      store: new PgSession({
        pool: tenantDb.pool,
        tableName: "session",
        createTableIfMissing: false, // handled by migrate()
      }),
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

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

server.listen(PORT, () => {
  console.log(`Capacycle Cloud running on http://localhost:${PORT}`);
});
