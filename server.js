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
import { notifyError } from "./notify.js";

const PgSession = connectPgSimple(session);

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  console.error("SESSION_SECRET environment variable is required");
  process.exit(1);
}

// Initialize database
await tenantDb.migrate();

// Build session middleware once so both Express and Socket.io can use it.
const sessionMiddleware = session({
  store: new PgSession({
    pool: tenantDb.pool,
    tableName: "session",
    createTableIfMissing: false,
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    // "lax" allows the cookie on top-level navigations (needed for Linear OAuth callback)
    // while blocking it on cross-site subresource requests, which covers the CSRF risk.
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
});

// Input validation helpers
const isValidId = (s) => typeof s === "string" && s.length > 0 && s.length <= 200;
const clampString = (s, max) => (typeof s === "string" ? s.slice(0, max) : "");

// Create cyclec app, skipping its built-in board/availability/actual-hours routes
// and socket handlers. Cloud mounts tenant-aware versions via afterRoutes.
const { server, app, io } = createApp({
  linearApiKey: null,

  getApiKeyForRequest: async (req) => {
    if (!req.session?.userId) return null;
    const user = await tenantDb.getUser(req.session.userId);
    if (!user) return null;
    return `Bearer ${user.linear_access_token}`;
  },

  onLinearAuthError: async (req) => {
    if (!req.session?.userId) return null;
    const newToken = await refreshLinearToken(req.session.userId);
    return newToken ? `Bearer ${newToken}` : null;
  },

  // Skip single-tenant routes and socket handlers; cloud mounts its own below.
  skipBoardRoutes: true,
  skipSocketHandlers: true,

  linearWebhookSecret: process.env.LINEAR_WEBHOOK_SECRET || null,

  // Cloud-aware Linear webhook handler: resolve tenant from org ID, scope emit to tenant
  onLinearWebhook: async ({ type, action, eventData, payload, io: ioRef }) => {
    // Linear may put organizationId on the top-level payload or inside data
    const orgId = payload?.organizationId || eventData?.organizationId;
    if (!orgId) return;
    const { rows } = await tenantDb.pool.query(
      "SELECT id FROM tenants WHERE linear_org_id = $1", [orgId]
    );
    const tenantId = rows[0]?.id;
    if (!tenantId) return;
    // Emit only to sockets of this tenant — frontend refetches team data and issues,
    // which updates burndown, velocity, capacity, insights, and forecasting views
    ioRef.to(`tenant:${tenantId}`).emit("data-updated", { type, action });
  },

  beforeRoutes: (app) => {
    app.set("trust proxy", 1);
    app.use(cookieParser());

    // Access gate — set LAUNCH_CODE env var to enable
    const launchCode = process.env.LAUNCH_CODE;
    if (launchCode) {
      app.post("/gate", express.urlencoded({ extended: false }), (req, res) => {
        if (req.body.code === launchCode) {
          res.cookie("gate", launchCode, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" });
          res.redirect("/");
        } else {
          res.send(gatePage("Wrong code"));
        }
      });
      app.use((req, res, next) => {
        if (req.path === "/gate" || req.path.startsWith("/api/webhooks/") || req.path === "/api/billing/webhook") return next();
        if (req.path.startsWith("/api/report/") || req.path.startsWith("/report/")) return next();
        if (req.path === "/robots.txt" || req.path === "/sitemap.xml") return next();
        // Allow static assets for report page rendering
        if (req.path.match(/\.(js|css|svg|png|ico|woff2?)$/)) return next();
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

    app.use("/auth/", rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
    }));

    app.use("/api/billing/", rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
    }));

    app.use(sessionMiddleware);

    // Public report view — no auth required, accessed via unique token
    app.get("/api/report/:token", async (req, res) => {
      try {
        const report = await tenantDb.getReportByToken(req.params.token);
        if (!report) return res.status(404).json({ error: "Report not found" });
        res.json({
          snapshot: report.snapshot,
          note: report.note,
          createdAt: report.created_at,
        });
      } catch (err) {
        res.status(500).json({ error: "Failed to load report" });
      }
    });

    app.use(authRouter);
    app.use(requireAuth);
    app.use(billingRouter);

    // Tenant settings (before subscription check so settings stay accessible)
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

    app.use(requireActiveSubscription);
  },

  // All tenant-aware board/availability/actual-hours/reports routes go here
  afterRoutes: ({ app, io }) => {
    // --- Reports ---
    app.post("/api/reports", express.json({ limit: "500kb" }), async (req, res) => {
      try {
        const { teamId, cycleId, snapshot, note } = req.body;
        if (!isValidId(teamId) || !isValidId(cycleId)) {
          return res.status(400).json({ error: "Invalid teamId or cycleId" });
        }
        if (!snapshot || typeof snapshot !== "object") {
          return res.status(400).json({ error: "Invalid snapshot data" });
        }
        const report = await tenantDb.createReport(req.session.tenantId, {
          teamId,
          cycleId,
          snapshot,
          note: typeof note === "string" ? note.slice(0, 5000) : null,
          createdBy: req.session.userId,
        });
        res.json({ id: report.id, token: report.token, createdAt: report.created_at });
      } catch (err) {
        console.error("Create report error:", err.message);
        res.status(500).json({ error: "Failed to create report" });
      }
    });

    app.get("/api/reports/:teamId/:cycleId", async (req, res) => {
      try {
        const { teamId, cycleId } = req.params;
        const reports = await tenantDb.getReportsForCycle(req.session.tenantId, teamId, cycleId);
        res.json(reports);
      } catch (err) {
        res.status(500).json({ error: "Failed to list reports" });
      }
    });

    app.delete("/api/reports/:reportId", async (req, res) => {
      try {
        await tenantDb.deleteReport(req.session.tenantId, req.params.reportId);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: "Failed to delete report" });
      }
    });

    // --- Action item follow-through ---
    app.get("/api/board/:teamId/:cycleId/previous-actions", async (req, res) => {
      try {
        const { teamId, cycleId } = req.params;
        const previousCycleId = req.query.previousCycleId;
        if (!isValidId(teamId) || !isValidId(cycleId) || !previousCycleId || !isValidId(previousCycleId)) {
          return res.status(400).json({ error: "Invalid parameters" });
        }
        const items = await tenantDb.getPreviousActionItems(
          req.session.tenantId, teamId, previousCycleId, cycleId
        );
        res.json(items);
      } catch (err) {
        console.error("Previous actions error:", err.message);
        res.status(500).json({ error: "Failed to load action items" });
      }
    });

    app.put("/api/action-items/:cardId/resolve", express.json(), async (req, res) => {
      try {
        const { cardId } = req.params;
        const { cycleId, resolved } = req.body;
        if (!isValidId(cardId) || !isValidId(cycleId)) {
          return res.status(400).json({ error: "Invalid parameters" });
        }
        await tenantDb.resolveActionItem(
          req.session.tenantId, cardId, cycleId, !!resolved
        );
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: "Failed to update action item" });
      }
    });

    // --- Board REST (initial load) ---
    app.get("/api/board/:teamId/:cycleId", async (req, res) => {
      try {
        const { teamId, cycleId } = req.params;
        if (!isValidId(teamId) || !isValidId(cycleId)) {
          return res.status(400).json({ error: "Invalid teamId or cycleId" });
        }
        // voterId derived from session userId (not client-controlled)
        const voterId = req.session.userId;
        const board = await tenantDb.getFullBoard(req.session.tenantId, teamId, cycleId, voterId);
        res.json(board);
      } catch (err) {
        console.error("Board error:", err.message);
        res.status(500).json({ error: "Failed to load board" });
      }
    });

    // --- Availability ---
    app.get("/api/availability/:teamId/:cycleId", async (req, res) => {
      try {
        const { teamId, cycleId } = req.params;
        if (!isValidId(teamId) || !isValidId(cycleId)) {
          return res.status(400).json({ error: "Invalid teamId or cycleId" });
        }
        const data = await tenantDb.getAvailability(req.session.tenantId, teamId, cycleId);
        res.json(data);
      } catch (err) {
        res.status(500).json({ error: "Failed to load availability" });
      }
    });

    app.put("/api/availability/:teamId/:cycleId", express.json({ limit: "50kb" }), async (req, res) => {
      try {
        const { teamId, cycleId } = req.params;
        if (!isValidId(teamId) || !isValidId(cycleId)) {
          return res.status(400).json({ error: "Invalid teamId or cycleId" });
        }
        if (!req.body || typeof req.body !== "object") {
          return res.status(400).json({ error: "Invalid body" });
        }
        await tenantDb.setAvailability(req.session.tenantId, teamId, cycleId, req.body);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: "Failed to save availability" });
      }
    });

    // --- Actual hours ---
    app.post("/api/actual-hours", express.json(), async (req, res) => {
      try {
        const { issueIds } = req.body;
        if (!Array.isArray(issueIds)) {
          return res.status(400).json({ error: "issueIds must be an array" });
        }
        if (issueIds.some((id) => !isValidId(id))) {
          return res.status(400).json({ error: "Invalid issue id" });
        }
        const hours = await tenantDb.getActualHours(req.session.tenantId, issueIds);
        res.json(hours);
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch hours" });
      }
    });

    app.put("/api/actual-hours/:issueId", express.json(), async (req, res) => {
      try {
        if (!isValidId(req.params.issueId)) {
          return res.status(400).json({ error: "Invalid issueId" });
        }
        const hours = parseFloat(req.body.hours);
        if (isNaN(hours) || hours < 0 || hours > 10000) {
          return res.status(400).json({ error: "Invalid hours value" });
        }
        await tenantDb.setActualHours(req.session.tenantId, req.params.issueId, hours);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: "Failed to save hours" });
      }
    });

    // --- Socket.io with auth and tenant isolation ---

    // Attach session to socket so we can read userId/tenantId
    io.engine.use((req, res, next) => {
      sessionMiddleware(req, res, next);
    });

    // Reject unauthenticated sockets
    io.use((socket, next) => {
      const session = socket.request.session;
      if (!session?.userId || !session?.tenantId) {
        return next(new Error("Unauthorized"));
      }
      socket.userId = session.userId;
      socket.tenantId = session.tenantId;
      next();
    });

    io.on("connection", (socket) => {
      let currentRoom = null;
      const voterId = socket.userId; // derived from session, not client-controlled
      const tenantId = socket.tenantId;

      // Always join the tenant-wide room for data-updated events
      socket.join(`tenant:${tenantId}`);

      socket.on("join-board", async ({ teamId, cycleId }) => {
        try {
          if (!isValidId(teamId) || !isValidId(cycleId)) return;
          if (currentRoom) socket.leave(currentRoom);
          // Scope rooms by tenant so cross-tenant clients can't join the same logical room
          currentRoom = `board:${tenantId}:${teamId}:${cycleId}`;
          socket.join(currentRoom);
          socket.teamId = teamId;
          socket.cycleId = cycleId;
        } catch (err) {
          socket.emit("error", { message: "Failed to join board" });
        }
      });

      socket.on("add-card", async ({ columnId, boardId, text }) => {
        try {
          if (!isValidId(columnId) || !isValidId(boardId)) return;
          await tenantDb.assertBoardAccess(tenantId, boardId);
          await tenantDb.assertColumnAccess(tenantId, columnId);
          const card = await tenantDb.addCard(columnId, boardId, clampString(text, 10000));
          if (currentRoom) io.to(currentRoom).emit("card-added", card);
        } catch (err) {
          socket.emit("error", { message: err.message });
        }
      });

      socket.on("update-card", async ({ cardId, text }) => {
        try {
          if (!isValidId(cardId)) return;
          await tenantDb.assertCardAccess(tenantId, cardId);
          const card = await tenantDb.updateCard(cardId, clampString(text, 10000));
          if (currentRoom) io.to(currentRoom).emit("card-updated", card);
        } catch (err) {
          socket.emit("error", { message: err.message });
        }
      });

      socket.on("move-card", async ({ cardId, newColumnId, newPosition }) => {
        try {
          if (!isValidId(cardId) || !isValidId(newColumnId)) return;
          if (typeof newPosition !== "number") return;
          await tenantDb.assertCardAccess(tenantId, cardId);
          await tenantDb.assertColumnAccess(tenantId, newColumnId);
          const card = await tenantDb.moveCard(cardId, newColumnId, newPosition);
          if (currentRoom) io.to(currentRoom).emit("card-moved", card);
        } catch (err) {
          socket.emit("error", { message: err.message });
        }
      });

      socket.on("delete-card", async ({ cardId }) => {
        try {
          if (!isValidId(cardId)) return;
          await tenantDb.assertCardAccess(tenantId, cardId);
          await tenantDb.deleteCard(cardId);
          if (currentRoom) io.to(currentRoom).emit("card-deleted", { cardId });
        } catch (err) {
          socket.emit("error", { message: err.message });
        }
      });

      socket.on("toggle-vote", async ({ cardId }) => {
        try {
          if (!isValidId(cardId)) return;
          await tenantDb.assertCardAccess(tenantId, cardId);
          // voterId is always the session userId, never client-supplied
          const result = await tenantDb.toggleVote(cardId, voterId);
          if (currentRoom) io.to(currentRoom).emit("vote-updated", { ...result, voterId });
        } catch (err) {
          socket.emit("error", { message: err.message });
        }
      });

      socket.on("add-column", async ({ boardId, title, color }) => {
        try {
          if (!isValidId(boardId)) return;
          await tenantDb.assertBoardAccess(tenantId, boardId);
          const col = await tenantDb.addColumn(boardId, clampString(title, 500), clampString(color, 50) || null);
          if (currentRoom) io.to(currentRoom).emit("column-added", col);
        } catch (err) {
          socket.emit("error", { message: err.message });
        }
      });

      socket.on("update-column", async ({ columnId, title, position, color }) => {
        try {
          if (!isValidId(columnId)) return;
          if (typeof position !== "number") return;
          await tenantDb.assertColumnAccess(tenantId, columnId);
          const col = await tenantDb.updateColumn(columnId, clampString(title, 500), position, clampString(color, 50) || null);
          if (currentRoom) io.to(currentRoom).emit("column-updated", col);
        } catch (err) {
          socket.emit("error", { message: err.message });
        }
      });

      socket.on("delete-column", async ({ columnId }) => {
        try {
          if (!isValidId(columnId)) return;
          await tenantDb.assertColumnAccess(tenantId, columnId);
          await tenantDb.deleteColumn(columnId);
          if (currentRoom) io.to(currentRoom).emit("column-deleted", { columnId });
        } catch (err) {
          socket.emit("error", { message: err.message });
        }
      });

      socket.on("reset-board", async ({ teamId, cycleId, preset }) => {
        try {
          if (!isValidId(teamId) || !isValidId(cycleId)) return;
          const safePreset = ["retrospective", "planning", "custom"].includes(preset) ? preset : "custom";
          await tenantDb.resetBoard(tenantId, teamId, cycleId, safePreset);
          const board = await tenantDb.getFullBoard(tenantId, teamId, cycleId, voterId);
          if (currentRoom) io.to(currentRoom).emit("board-reset", board);
        } catch (err) {
          socket.emit("error", { message: err.message });
        }
      });
    });
  },
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  notifyError("Unhandled rejection", err);
});

server.listen(PORT, () => {
  console.log(`Capacycle Cloud running on http://localhost:${PORT}`);
});
