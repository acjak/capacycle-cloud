import "dotenv/config";
import express from "express";
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
    // Trust fly.io reverse proxy (needed for secure cookies behind SSL termination)
    app.set("trust proxy", 1);

    // Cookie parser (needed early for access gate)
    app.use(cookieParser());

    // Access gate — set LAUNCH_CODE env var to enable (remove to open to public)
    const launchCode = process.env.LAUNCH_CODE;
    if (launchCode) {
      app.post("/gate", express.urlencoded({ extended: false }), (req, res) => {
        if (req.body.code === launchCode) {
          res.cookie("gate", launchCode, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, secure: process.env.NODE_ENV === "production" });
          res.redirect("/");
        } else {
          res.send(gatePage("Wrong code"));
        }
      });
      app.use((req, res, next) => {
        if (req.path === "/gate" || req.path.startsWith("/api/webhooks/") || req.path === "/api/billing/webhook") return next();
        if (req.cookies?.gate === launchCode) return next();
        res.send(gatePage());
      });
    }

    function gatePage(error) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Capacycle</title><style>*{box-sizing:border-box;margin:0}body{background:#0d0f14;color:#e4e6eb;font-family:'DM Sans',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#14161d;border:1px solid #22252e;border-radius:12px;padding:48px 40px;text-align:center;max-width:340px;width:100%}
h1{font-size:22px;font-weight:700;margin-bottom:8px}p{font-size:13px;color:#7a7f8e;margin-bottom:24px}
input{background:#0d0f14;border:1px solid #22252e;border-radius:6px;padding:10px 14px;font-size:14px;color:#e4e6eb;width:100%;margin-bottom:12px;text-align:center;outline:none}
input:focus{border-color:#5b7fff}button{background:#5b7fff;color:#fff;border:none;border-radius:8px;padding:10px 24px;font-size:14px;font-weight:600;cursor:pointer;width:100%}
.err{color:#ff4d4d;font-size:12px;margin-bottom:12px}</style></head>
<body><div class="card"><h1>Capacycle</h1><p>This site is not yet open to the public.</p>
<form method="POST" action="/gate"><input name="code" type="password" placeholder="Access code" autofocus>
${error ? `<div class="err">${error}</div>` : ""}
<button type="submit">Enter</button></form></div></body></html>`;
    }

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

    // Tenant settings routes (after auth, before subscription check so settings are always accessible)
    app.get("/api/settings", async (req, res) => {
      try {
        const settings = await tenantDb.getTenantSettings(req.session.tenantId);
        res.json(settings);
      } catch (err) {
        res.status(500).json({ error: "Failed to load settings" });
      }
    });

    app.put("/api/settings", express.json(), async (req, res) => {
      try {
        const user = await tenantDb.getUser(req.session.userId);
        if (!user || user.role !== "owner") {
          return res.status(403).json({ error: "Only the workspace owner can change settings" });
        }
        await tenantDb.updateTenantSettings(req.session.tenantId, req.body);
        const settings = await tenantDb.getTenantSettings(req.session.tenantId);
        res.json(settings);
      } catch (err) {
        res.status(500).json({ error: "Failed to update settings" });
      }
    });

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
