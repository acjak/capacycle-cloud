import "dotenv/config";
import { migrate, pool } from "./tenant-db.js";

try {
  await migrate();
  console.log("Migration complete");
} catch (err) {
  console.error("Migration failed:", err);
  process.exit(1);
} finally {
  await pool.end();
}
