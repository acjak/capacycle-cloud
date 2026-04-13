import express from "express";
import Stripe from "stripe";
import * as tenantDb from "./tenant-db.js";

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_ID,
  APP_URL = "http://localhost:3000",
} = process.env;

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const router = express.Router();

// Only tenant owners can manage billing
async function requireOwner(req, res, next) {
  const user = await tenantDb.getUser(req.session.userId);
  if (!user || user.role !== "owner") {
    return res.status(403).json({ error: "Only the workspace owner can manage billing" });
  }
  next();
}

// Create checkout session
router.post("/api/billing/checkout", requireOwner, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Billing not configured" });

  const tenantId = req.session.tenantId;
  const sub = await tenantDb.getSubscription(tenantId);
  const tenant = await tenantDb.getTenant(tenantId);

  let customerId = sub?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { tenantId, linearOrgId: tenant.linear_org_id },
    });
    customerId = customer.id;
    await tenantDb.updateSubscription(tenantId, { stripe_customer_id: customerId });
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${APP_URL}?billing=success`,
    cancel_url: `${APP_URL}?billing=cancel`,
    metadata: { tenantId },
  });

  res.json({ url: session.url });
});

// Billing portal
router.post("/api/billing/portal", requireOwner, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Billing not configured" });

  const sub = await tenantDb.getSubscription(req.session.tenantId);
  if (!sub?.stripe_customer_id) {
    return res.status(400).json({ error: "No billing account" });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: APP_URL,
  });

  res.json({ url: session.url });
});

// Get subscription status
router.get("/api/billing/status", async (req, res) => {
  const sub = await tenantDb.getSubscription(req.session.tenantId);
  if (!sub) {
    return res.json({ status: "none" });
  }
  res.json({
    status: sub.status,
    trialEndsAt: sub.trial_ends_at,
    currentPeriodEnd: sub.current_period_end,
  });
});

// Stripe webhook (raw body required)
router.post("/api/billing/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return res.status(503).send("Webhooks not configured");
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send("Invalid signature");
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const tenantId = session.metadata.tenantId;
        if (tenantId && session.subscription) {
          await tenantDb.updateSubscription(tenantId, {
            stripe_subscription_id: session.subscription,
            status: "active",
          });
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        // Find tenant by customer ID
        const { rows } = await tenantDb.pool.query(
          "SELECT tenant_id FROM subscriptions WHERE stripe_customer_id = $1",
          [customerId]
        );
        if (rows[0]) {
          await tenantDb.updateSubscription(rows[0].tenant_id, {
            status: subscription.status === "active" ? "active"
              : subscription.status === "trialing" ? "trialing"
              : "canceled",
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          });
        }
        break;
      }
    }

    res.json({ received: true });
  }
);

// Middleware: check subscription is active or trialing
export function requireActiveSubscription(req, res, next) {
  if (req.path.startsWith("/auth/")) return next();
  if (req.path.startsWith("/api/billing/")) return next();
  if (req.path.startsWith("/api/webhooks/")) return next();
  if (!req.path.startsWith("/api/")) return next();

  // Check subscription asynchronously
  tenantDb.getSubscription(req.session.tenantId).then((sub) => {
    if (!sub) {
      return res.status(402).json({ error: "No subscription", code: "NO_SUBSCRIPTION" });
    }

    const now = new Date();
    if (sub.status === "active") return next();
    if (sub.status === "trialing" && new Date(sub.trial_ends_at) > now) return next();

    return res.status(402).json({ error: "Subscription expired", code: "SUBSCRIPTION_EXPIRED" });
  }).catch(next);
}

export default router;
