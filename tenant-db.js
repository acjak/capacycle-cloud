import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// --- Schema setup ---

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      linear_org_id TEXT UNIQUE,
      name TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      linear_user_id TEXT NOT NULL,
      name TEXT,
      email TEXT,
      avatar_url TEXT,
      linear_access_token TEXT NOT NULL,
      linear_refresh_token TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(tenant_id, linear_user_id)
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      plan TEXT,
      team_id TEXT,
      status TEXT NOT NULL DEFAULT 'trialing',
      trial_ends_at TIMESTAMPTZ DEFAULT (now() + interval '14 days'),
      current_period_end TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(tenant_id, team_id)
    );

    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL,
      cycle_id TEXT NOT NULL,
      preset TEXT NOT NULL DEFAULT 'custom',
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(tenant_id, team_id, cycle_id)
    );

    CREATE TABLE IF NOT EXISTS board_columns (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      color TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      column_id TEXT NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS votes (
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      voter_id TEXT NOT NULL,
      PRIMARY KEY (card_id, voter_id)
    );

    CREATE TABLE IF NOT EXISTS actual_hours (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      issue_id TEXT NOT NULL,
      hours REAL NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (tenant_id, issue_id)
    );

    CREATE TABLE IF NOT EXISTS availability (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL,
      cycle_id TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (tenant_id, team_id, cycle_id)
    );

    CREATE TABLE IF NOT EXISTS "session" (
      "sid" VARCHAR NOT NULL COLLATE "default",
      "sess" JSON NOT NULL,
      "expire" TIMESTAMP(6) NOT NULL,
      PRIMARY KEY ("sid")
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

    -- Add settings column to tenants if missing
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);
}

// --- Tenant operations ---

export async function findOrCreateTenant(linearOrgId, name) {
  const existing = await pool.query(
    "SELECT * FROM tenants WHERE linear_org_id = $1", [linearOrgId]
  );
  if (existing.rows[0]) return { ...existing.rows[0], isNew: false };

  const result = await pool.query(
    "INSERT INTO tenants (linear_org_id, name) VALUES ($1, $2) RETURNING *",
    [linearOrgId, name]
  );
  // Create trial subscription
  await pool.query(
    "INSERT INTO subscriptions (tenant_id) VALUES ($1)",
    [result.rows[0].id]
  );
  return { ...result.rows[0], isNew: true };
}

export async function getTenant(id) {
  const result = await pool.query("SELECT * FROM tenants WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function getTenantSettings(tenantId) {
  const result = await pool.query("SELECT settings FROM tenants WHERE id = $1", [tenantId]);
  return result.rows[0]?.settings || {};
}

export async function updateTenantSettings(tenantId, settings) {
  await pool.query(
    "UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1",
    [tenantId, JSON.stringify(settings)]
  );
}

// --- User operations ---

export async function upsertUser(tenantId, { linearUserId, name, email, avatarUrl, accessToken, refreshToken, role = "member" }) {
  const result = await pool.query(`
    INSERT INTO users (tenant_id, linear_user_id, name, email, avatar_url, linear_access_token, linear_refresh_token, role)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (tenant_id, linear_user_id) DO UPDATE SET
      name = EXCLUDED.name,
      email = EXCLUDED.email,
      avatar_url = EXCLUDED.avatar_url,
      linear_access_token = EXCLUDED.linear_access_token,
      linear_refresh_token = COALESCE(EXCLUDED.linear_refresh_token, users.linear_refresh_token)
    RETURNING *
  `, [tenantId, linearUserId, name, email, avatarUrl, accessToken, refreshToken, role]);
  return result.rows[0];
}

export async function updateUserTokens(userId, accessToken, refreshToken) {
  await pool.query(
    "UPDATE users SET linear_access_token = $1, linear_refresh_token = $2 WHERE id = $3",
    [accessToken, refreshToken, userId]
  );
}

export async function getUser(id) {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] || null;
}

// --- Subscription operations ---

// Get all subscriptions for a tenant
export async function getSubscriptions(tenantId) {
  const result = await pool.query(
    "SELECT * FROM subscriptions WHERE tenant_id = $1", [tenantId]
  );
  return result.rows;
}

// Get the "primary" subscription — org plan, or active trial, or first active
export async function getSubscription(tenantId) {
  const result = await pool.query(
    "SELECT * FROM subscriptions WHERE tenant_id = $1 ORDER BY CASE WHEN team_id IS NULL THEN 0 ELSE 1 END, created_at LIMIT 1",
    [tenantId]
  );
  return result.rows[0] || null;
}

// Check if tenant has access to a specific team
export async function hasTeamAccess(tenantId, teamId) {
  const subs = await getSubscriptions(tenantId);
  const now = new Date();
  for (const sub of subs) {
    const active = sub.status === "active" ||
      (sub.status === "trialing" && new Date(sub.trial_ends_at) > now);
    if (!active) continue;
    // Org plan or trial (no team_id) covers all teams
    if (!sub.team_id) return true;
    // Team plan covers specific team
    if (sub.team_id === teamId) return true;
  }
  return false;
}

// Get list of team IDs this tenant has access to (null = all teams)
export async function getAccessibleTeams(tenantId) {
  const subs = await getSubscriptions(tenantId);
  const now = new Date();
  const teamIds = [];
  for (const sub of subs) {
    const active = sub.status === "active" ||
      (sub.status === "trialing" && new Date(sub.trial_ends_at) > now);
    if (!active) continue;
    if (!sub.team_id) return null; // org plan or trial = all teams
    teamIds.push(sub.team_id);
  }
  return teamIds.length > 0 ? teamIds : [];
}

export async function updateSubscription(tenantId, fields, teamId = undefined) {
  const sets = [];
  const vals = [tenantId];
  let i = 2;
  for (const [key, val] of Object.entries(fields)) {
    sets.push(`${key} = $${i}`);
    vals.push(val);
    i++;
  }
  const teamCondition = teamId === undefined
    ? "" : teamId === null
    ? " AND team_id IS NULL" : ` AND team_id = $${i}`;
  if (teamId !== undefined && teamId !== null) vals.push(teamId);
  await pool.query(
    `UPDATE subscriptions SET ${sets.join(", ")} WHERE tenant_id = $1${teamCondition}`,
    vals
  );
}

// --- Board operations (tenant-scoped, Postgres-backed) ---

export async function getOrCreateBoard(tenantId, teamId, cycleId, preset = "retrospective") {
  const existing = await pool.query(
    "SELECT * FROM boards WHERE tenant_id = $1 AND team_id = $2 AND cycle_id = $3",
    [tenantId, teamId, cycleId]
  );
  if (existing.rows[0]) return existing.rows[0];

  const result = await pool.query(
    "INSERT INTO boards (tenant_id, team_id, cycle_id, preset) VALUES ($1, $2, $3, $4) RETURNING *",
    [tenantId, teamId, cycleId, preset]
  );
  const board = result.rows[0];

  const { PRESETS } = await import("cyclec/db");
  const cols = PRESETS[preset] || PRESETS.custom;
  for (const col of cols) {
    await pool.query(
      "INSERT INTO board_columns (board_id, title, position, color) VALUES ($1, $2, $3, $4)",
      [board.id, col.title, col.position, col.color]
    );
  }
  return board;
}

export async function getFullBoard(tenantId, teamId, cycleId, voterId) {
  const board = await getOrCreateBoard(tenantId, teamId, cycleId);
  const columns = await pool.query(
    "SELECT * FROM board_columns WHERE board_id = $1 ORDER BY position", [board.id]
  );
  const cards = await pool.query(
    "SELECT * FROM cards WHERE board_id = $1 ORDER BY position", [board.id]
  );
  const voteRows = await pool.query(
    "SELECT card_id, COUNT(*) as count FROM votes WHERE card_id IN (SELECT id FROM cards WHERE board_id = $1) GROUP BY card_id",
    [board.id]
  );
  const voteCounts = {};
  voteRows.rows.forEach(v => { voteCounts[v.card_id] = parseInt(v.count); });

  const myVotes = new Set();
  if (voterId) {
    const myVoteRows = await pool.query(
      "SELECT card_id FROM votes WHERE voter_id = $1 AND card_id IN (SELECT id FROM cards WHERE board_id = $2)",
      [voterId, board.id]
    );
    myVoteRows.rows.forEach(v => myVotes.add(v.card_id));
  }

  return {
    id: board.id,
    preset: board.preset,
    columns: columns.rows.map(col => ({
      ...col,
      cards: cards.rows
        .filter(c => c.column_id === col.id)
        .map(c => ({
          ...c,
          votes: voteCounts[c.id] || 0,
          myVote: myVotes.has(c.id),
        })),
    })),
  };
}

export async function resetBoard(tenantId, teamId, cycleId, preset) {
  const existing = await pool.query(
    "SELECT id FROM boards WHERE tenant_id = $1 AND team_id = $2 AND cycle_id = $3",
    [tenantId, teamId, cycleId]
  );
  if (existing.rows[0]) {
    await pool.query("DELETE FROM boards WHERE id = $1", [existing.rows[0].id]);
  }
  return getOrCreateBoard(tenantId, teamId, cycleId, preset);
}

export async function addColumn(boardId, title, color = null) {
  const maxPos = await pool.query(
    "SELECT COALESCE(MAX(position), -1) as max_pos FROM board_columns WHERE board_id = $1", [boardId]
  );
  const position = maxPos.rows[0].max_pos + 1;
  const result = await pool.query(
    "INSERT INTO board_columns (board_id, title, position, color) VALUES ($1, $2, $3, $4) RETURNING *",
    [boardId, title, position, color]
  );
  return result.rows[0];
}

export async function updateColumn(columnId, title, position, color) {
  await pool.query(
    "UPDATE board_columns SET title = $1, position = $2, color = $3 WHERE id = $4",
    [title, position, color, columnId]
  );
  return { id: columnId, title, position, color };
}

export async function deleteColumn(columnId) {
  await pool.query("DELETE FROM board_columns WHERE id = $1", [columnId]);
}

export async function addCard(columnId, boardId, text) {
  const maxPos = await pool.query(
    "SELECT COALESCE(MAX(position), -1) as max_pos FROM cards WHERE column_id = $1", [columnId]
  );
  const position = maxPos.rows[0].max_pos + 1;
  const result = await pool.query(
    "INSERT INTO cards (column_id, board_id, text, position) VALUES ($1, $2, $3, $4) RETURNING *",
    [columnId, boardId, text, position]
  );
  return { ...result.rows[0], votes: 0, myVote: false };
}

export async function updateCard(cardId, text) {
  const result = await pool.query(
    "UPDATE cards SET text = $1 WHERE id = $2 RETURNING *", [text, cardId]
  );
  return result.rows[0];
}

export async function moveCard(cardId, newColumnId, newPosition) {
  const result = await pool.query(
    "UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *",
    [newColumnId, newPosition, cardId]
  );
  return result.rows[0];
}

export async function deleteCard(cardId) {
  await pool.query("DELETE FROM cards WHERE id = $1", [cardId]);
}

export async function toggleVote(cardId, voterId) {
  const existing = await pool.query(
    "SELECT 1 FROM votes WHERE card_id = $1 AND voter_id = $2", [cardId, voterId]
  );
  if (existing.rows.length > 0) {
    await pool.query("DELETE FROM votes WHERE card_id = $1 AND voter_id = $2", [cardId, voterId]);
  } else {
    await pool.query(
      "INSERT INTO votes (card_id, voter_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [cardId, voterId]
    );
  }
  const count = await pool.query(
    "SELECT COUNT(*) as count FROM votes WHERE card_id = $1", [cardId]
  );
  return { cardId, count: parseInt(count.rows[0].count), voted: existing.rows.length === 0 };
}

// --- Actual hours (tenant-scoped) ---

export async function getActualHours(tenantId, issueIds) {
  if (!issueIds.length) return {};
  const result = await pool.query(
    "SELECT issue_id, hours FROM actual_hours WHERE tenant_id = $1 AND issue_id = ANY($2)",
    [tenantId, issueIds]
  );
  const hours = {};
  result.rows.forEach(r => { hours[r.issue_id] = parseFloat(r.hours); });
  return hours;
}

export async function setActualHours(tenantId, issueId, hours) {
  await pool.query(`
    INSERT INTO actual_hours (tenant_id, issue_id, hours) VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id, issue_id) DO UPDATE SET hours = EXCLUDED.hours, updated_at = now()
  `, [tenantId, issueId, hours]);
}

// --- Availability (tenant-scoped) ---

export async function getAvailability(tenantId, teamId, cycleId) {
  const result = await pool.query(
    "SELECT data FROM availability WHERE tenant_id = $1 AND team_id = $2 AND cycle_id = $3",
    [tenantId, teamId, cycleId]
  );
  return result.rows[0]?.data || { pointsPerDay: 2, people: {} };
}

export async function setAvailability(tenantId, teamId, cycleId, data) {
  await pool.query(`
    INSERT INTO availability (tenant_id, team_id, cycle_id, data) VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, team_id, cycle_id) DO UPDATE SET data = EXCLUDED.data
  `, [tenantId, teamId, cycleId, JSON.stringify(data)]);
}

export { pool };
