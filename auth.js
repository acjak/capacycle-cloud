import express from "express";
import crypto from "crypto";
import * as tenantDb from "./tenant-db.js";
import { notifyNewTenant, notifyNewUser } from "./notify.js";

const {
  LINEAR_CLIENT_ID,
  LINEAR_CLIENT_SECRET,
  LINEAR_REDIRECT_URI,
  APP_URL = "http://localhost:3000",
} = process.env;

const router = express.Router();

// Initiate Linear OAuth
router.get("/auth/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: LINEAR_CLIENT_ID,
    redirect_uri: LINEAR_REDIRECT_URI,
    response_type: "code",
    scope: "read",
    state,
    prompt: "consent",
  });

  res.redirect(`https://linear.app/oauth/authorize?${params}`);
});

// OAuth callback
router.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || state !== req.session.oauthState) {
    return res.status(400).send("Invalid OAuth callback");
  }
  delete req.session.oauthState;

  try {
    // Exchange code for token
    const tokenRes = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: LINEAR_CLIENT_ID,
        client_secret: LINEAR_CLIENT_SECRET,
        redirect_uri: LINEAR_REDIRECT_URI,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("Token exchange failed:", err);
      return res.status(400).send("Failed to authenticate with Linear");
    }

    const tokenData = await tokenRes.json();
    const { access_token, refresh_token } = tokenData;

    // Fetch user and org info from Linear
    const userRes = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify({
        query: `{
          viewer {
            id name email avatarUrl
            organization { id name }
          }
        }`,
      }),
    });

    const { data } = await userRes.json();
    const viewer = data.viewer;
    const org = viewer.organization;

    // Find or create tenant + user
    const tenant = await tenantDb.findOrCreateTenant(org.id, org.name);
    const user = await tenantDb.upsertUser(tenant.id, {
      linearUserId: viewer.id,
      name: viewer.name,
      email: viewer.email,
      avatarUrl: viewer.avatarUrl,
      accessToken: access_token,
      refreshToken: refresh_token || null,
      role: tenant.isNew ? "owner" : "member",
    });

    // Store in session
    req.session.userId = user.id;
    req.session.tenantId = tenant.id;

    // Notify
    if (tenant.isNew) {
      notifyNewTenant(org.name, viewer.name, viewer.email);
    } else {
      notifyNewUser(org.name, viewer.name, viewer.email);
    }

    res.redirect(APP_URL);
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("Authentication failed");
  }
});

// Logout
router.post("/auth/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// Get current user
router.get("/auth/me", async (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }
  const user = await tenantDb.getUser(req.session.userId);
  if (!user) {
    return res.json({ user: null });
  }
  let settings = {};
  try { settings = await tenantDb.getTenantSettings(req.session.tenantId); } catch {}
  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatar_url,
      role: user.role,
    },
    settings,
  });
});

// Refresh an expired Linear OAuth token
export async function refreshLinearToken(userId) {
  const user = await tenantDb.getUser(userId);
  if (!user?.linear_refresh_token) return null;

  const tokenRes = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: user.linear_refresh_token,
      client_id: LINEAR_CLIENT_ID,
      client_secret: LINEAR_CLIENT_SECRET,
    }),
  });

  if (!tokenRes.ok) {
    console.error("Token refresh failed:", await tokenRes.text());
    return null;
  }

  const { access_token, refresh_token } = await tokenRes.json();
  await tenantDb.updateUserTokens(userId, access_token, refresh_token || user.linear_refresh_token);
  return access_token;
}

// Middleware: require auth on /api/* routes
export function requireAuth(req, res, next) {
  // Skip auth endpoints
  if (req.path.startsWith("/auth/")) return next();
  // Skip webhook endpoints (called by Linear/Stripe, not users)
  if (req.path.startsWith("/api/webhooks/")) return next();
  if (req.path === "/api/billing/webhook") return next();
  // Skip static files
  if (!req.path.startsWith("/api/")) return next();

  if (!req.session.userId || !req.session.tenantId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

export default router;
