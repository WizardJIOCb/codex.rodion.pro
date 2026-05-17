import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { hashSecret, randomToken } from "./auth.js";
import { id, nowIso, openDb, type AgentRow, type UserRow } from "./db.js";

function argValue(name: "email" | "password" | "id" | "name" | "role" | "user-email"): string | undefined {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      password: { type: "string" },
      id: { type: "string" },
      name: { type: "string" },
      role: { type: "string" },
      "user-email": { type: "string" }
    },
    allowPositionals: true
  });
  return values[name] as string | undefined;
}

async function main() {
  const command = process.argv[2];
  const config = loadConfig();
  const db = openDb(config.databasePath);

  if (command === "seed:user") {
    const email = argValue("email") ?? process.env.CMC_OWNER_EMAIL;
    const password = argValue("password") ?? process.env.CMC_OWNER_PASSWORD;
    const role = argValue("role") === "user" ? "user" : "admin";
    if (!email || !password) throw new Error("Usage: seed:user --email you@example.com --password strong-password");
    const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
    const passwordHash = await hashSecret(password);
    if (existing) {
      db.prepare("UPDATE users SET password_hash = ?, role = ? WHERE email = ?").run(passwordHash, role, email);
      console.log(`Updated owner user ${email}`);
    } else {
      db.prepare("INSERT INTO users (id,email,password_hash,role,created_at) VALUES (?,?,?,?,?)")
        .run(id("usr"), email, passwordHash, role, nowIso());
      console.log(`Created owner user ${email}`);
    }
    return;
  }

  if (command === "agents:create" || command === "agents:rotate-token") {
    const agentId = argValue("id") ?? "home-windows";
    const name = argValue("name") ?? "Home Windows";
    const userEmail = argValue("user-email") ?? process.env.CMC_OWNER_EMAIL;
    const user = userEmail ? db.prepare("SELECT * FROM users WHERE email = ?").get(userEmail) as UserRow | undefined : undefined;
    const token = randomToken("cmc_agent");
    const tokenHash = await hashSecret(token);
    const existing = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
    if (existing) {
      db.prepare("UPDATE agents SET name = ?, token_hash = ?, user_id = COALESCE(?, user_id) WHERE id = ?").run(name, tokenHash, user?.id ?? null, agentId);
      console.log(`Updated agent ${agentId}`);
    } else {
      db.prepare("INSERT INTO agents (id,user_id,name,token_hash,status,created_at) VALUES (?,?,?,?,?,?)")
        .run(agentId, user?.id ?? null, name, tokenHash, "offline", nowIso());
      console.log(`Created agent ${agentId}`);
    }
    console.log(`Token: ${token}`);
    console.log("Store it only in CMC_AGENT_TOKEN on the Windows PC.");
    return;
  }

  throw new Error("Unknown command. Use seed:user, agents:create, or agents:rotate-token.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
