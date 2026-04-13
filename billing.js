import express from "express";
import Stripe from "stripe";
import * as tenantDb from "./tenant-db.js";
import { notifyPayment, notifyChurn } from "./notify.js";

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  APP_URL = "http://localhost:3000",
} = process.env;

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const router = express.Router();

// Price lookup keys → Stripe price IDs (resolved on startup)
const PLANS = {
  team_monthly: { priceId: null, name: "Team", interval: "month", amount: 900 },
  team_annual: { priceId: null, name: "Team", interval: "year", amount: 8400 },
  org_monthly: { priceId: null, name: "Organization", interval: "month", amount: 2900 },
  org_annual: { priceId: null, name: "Organization", interval: "year", amount: 27600 },
};

// Resolve price IDs from lookup keys on startup
async function resolvePrices() {
  if (!stripe) return;
  try {
    const prices = await stripe.prices.list({ lookup_keys: Object.keys(PLANS), limit: 10 });
    for (const price of prices.data) {
      if (PLANS[price.lookup_key]) {
        PLANS[price.lookup_key].priceId = price.id;
      }
    }
    const resolved = Object.values(PLANS).filter((p) => p.priceId).length;
    console.log(`Stripe: resolved ${resolved}/${Object.keys(PLANS).length} prices`);
  } catch (err) {
    console.error("Failed to resolve Stripe prices:", err.message);
  }
}
resolvePrices();

// Only tenant owners can manage billing
async function requireOwner(req, res, next) {
  const user = await tenantDb.getUser(req.session.userId);
  if (!user || user.role !== "owner") {
    return res.status(403).json({ error: "Only the workspace owner can manage billing" });
  }
  next();
}

// Get available plans
router.get("/api/billing/plans", (req, res) => {
  const plans = Object.entries(PLANS).map(([key, plan]) => ({
    key,
    name: plan.name,
    interval: plan.interval,
    amount: plan.amount,
    available: !!plan.priceId,
  }));
  res.json({ plans });
});

// Create checkout session
router.post("/api/billing/checkout", requireOwner, express.json(), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Billing not configured" });

  const { plan, teamId } = req.body;
  const selectedPlan = PLANS[plan];
  if (!selectedPlan?.priceId) {
    return res.status(400).json({ error: "Invalid plan" });
  }

  // Team plans require a teamId
  const isTeamPlan = plan.startsWith("team_");
  if (isTeamPlan && !teamId) {
    return res.status(400).json({ error: "Team plan requires a teamId" });
  }

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
    line_items: [{ price: selectedPlan.priceId, quantity: 1 }],
    success_url: `${APP_URL}?billing=success`,
    cancel_url: `${APP_URL}?billing=cancel`,
    metadata: { tenantId, plan, teamId: teamId || "" },
    allow_promotion_codes: true,
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
  const tenantId = req.session.tenantId;
  const subs = await tenantDb.getSubscriptions(tenantId);
  if (subs.length === 0) {
    return res.json({ status: "none" });
  }
  const primary = subs.find((s) => !s.team_id) || subs[0];
  const accessibleTeams = await tenantDb.getAccessibleTeams(tenantId);
  res.json({
    status: primary.status,
    plan: primary.plan || null,
    trialEndsAt: primary.trial_ends_at,
    currentPeriodEnd: primary.current_period_end,
    accessibleTeams, // null = all teams, [] = none, ["id1","id2"] = specific teams
    subscriptions: subs.map((s) => ({
      plan: s.plan,
      teamId: s.team_id,
      status: s.status,
    })),
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
        const plan = session.metadata.plan || null;
        const teamId = session.metadata.teamId || null;
        if (tenantId && session.subscription) {
          const isTeamPlan = plan?.startsWith("team_");
          if (isTeamPlan && teamId) {
            // Create a new team-specific subscription
            await tenantDb.pool.query(`
              INSERT INTO subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, plan, team_id, status)
              VALUES ($1, $2, $3, $4, $5, 'active')
              ON CONFLICT (tenant_id, team_id) DO UPDATE SET
                stripe_subscription_id = EXCLUDED.stripe_subscription_id,
                plan = EXCLUDED.plan,
                status = 'active'
            `, [tenantId, session.customer, session.subscription, plan, teamId]);
          } else {
            // Org plan — update the main subscription (team_id IS NULL)
            await tenantDb.updateSubscription(tenantId, {
              stripe_subscription_id: session.subscription,
              stripe_customer_id: session.customer,
              status: "active",
              plan,
            }, null);
          }
          // Notify
          const tenant = await tenantDb.getTenant(tenantId);
          const planInfo = PLANS[plan];
          notifyPayment(tenant?.name || tenantId, plan, planInfo?.amount || 0);
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const { rows } = await tenantDb.pool.query(
          "SELECT tenant_id FROM subscriptions WHERE stripe_customer_id = $1",
          [customerId]
        );
        if (rows[0]) {
          const newStatus = subscription.status === "active" ? "active"
            : subscription.status === "trialing" ? "trialing"
            : "canceled";
          await tenantDb.updateSubscription(rows[0].tenant_id, {
            status: newStatus,
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          });
          // Notify on cancellation
          if (newStatus === "canceled") {
            const tenant = await tenantDb.getTenant(rows[0].tenant_id);
            notifyChurn(tenant?.name || rows[0].tenant_id);
          }
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

  tenantDb.getSubscriptions(req.session.tenantId).then((subs) => {
    if (subs.length === 0) {
      return res.status(402).json({ error: "No subscription", code: "NO_SUBSCRIPTION" });
    }

    const now = new Date();
    const hasActive = subs.some((sub) =>
      sub.status === "active" ||
      (sub.status === "trialing" && new Date(sub.trial_ends_at) > now)
    );

    if (hasActive) return next();
    return res.status(402).json({ error: "Subscription expired", code: "SUBSCRIPTION_EXPIRED" });
  }).catch(next);
}

export default router;
