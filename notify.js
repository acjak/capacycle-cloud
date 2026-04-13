// Discord webhook notifications for Capacycle ops events.
// Set DISCORD_WEBHOOK_URL env var to enable.

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

async function send(content, embeds = []) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, embeds }),
    });
  } catch (err) {
    console.error("Discord notification failed:", err.message);
  }
}

export function notifyNewTenant(orgName, userName, userEmail) {
  send(null, [{
    title: "New workspace",
    color: 0x36b87a, // green
    fields: [
      { name: "Organization", value: orgName, inline: true },
      { name: "Owner", value: userName, inline: true },
      { name: "Email", value: userEmail, inline: true },
    ],
    timestamp: new Date().toISOString(),
  }]);
}

export function notifyNewUser(orgName, userName, userEmail) {
  send(null, [{
    title: "New user joined",
    color: 0x5b7fff, // blue
    fields: [
      { name: "Organization", value: orgName, inline: true },
      { name: "User", value: userName, inline: true },
      { name: "Email", value: userEmail, inline: true },
    ],
    timestamp: new Date().toISOString(),
  }]);
}

export function notifyPayment(orgName, plan, amount) {
  const planLabel = plan?.replace("_", " ") || "unknown";
  const dollars = (amount / 100).toFixed(2);
  send(null, [{
    title: "New subscription",
    color: 0xe8a820, // gold
    fields: [
      { name: "Organization", value: orgName, inline: true },
      { name: "Plan", value: planLabel, inline: true },
      { name: "Amount", value: `$${dollars}`, inline: true },
    ],
    timestamp: new Date().toISOString(),
  }]);
}

export function notifyChurn(orgName) {
  send(null, [{
    title: "Subscription canceled",
    color: 0xff4d4d, // red
    fields: [
      { name: "Organization", value: orgName, inline: true },
    ],
    timestamp: new Date().toISOString(),
  }]);
}

export function notifyError(context, error) {
  send(null, [{
    title: "Error",
    color: 0xff4d4d,
    description: `**${context}**\n\`\`\`${String(error).slice(0, 500)}\`\`\``,
    timestamp: new Date().toISOString(),
  }]);
}
