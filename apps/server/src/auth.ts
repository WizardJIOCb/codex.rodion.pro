import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "./config.js";
import { id, nowIso, type SessionRow, type UserRow } from "./db.js";

const cookieName = "cmc_session";

export function randomToken(prefix = "cmc"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export async function hashSecret(secret: string): Promise<string> {
  return bcrypt.hash(secret, 12);
}

export async function verifySecret(secret: string, hash: string): Promise<boolean> {
  return bcrypt.compare(secret, hash);
}

export async function createSession(db: DatabaseSync, userId: string): Promise<SessionRow> {
  const session: SessionRow = {
    id: id("ses"),
    user_id: userId,
    csrf_token: randomToken("csrf"),
    expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
    created_at: nowIso()
  };
  db.prepare("INSERT INTO sessions (id,user_id,csrf_token,expires_at,created_at) VALUES (?,?,?,?,?)")
    .run(session.id, session.user_id, session.csrf_token, session.expires_at, session.created_at);
  return session;
}

export function setSessionCookie(reply: FastifyReply, config: ServerConfig, sessionId: string): void {
  reply.setCookie(cookieName, sessionId, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    domain: config.cookieDomain,
    maxAge: 60 * 60 * 24 * 30
  });
}

export function clearSessionCookie(reply: FastifyReply, config: ServerConfig): void {
  reply.clearCookie(cookieName, { path: "/", domain: config.cookieDomain });
}

export function getSession(db: DatabaseSync, request: FastifyRequest): { session: SessionRow; user: UserRow } | null {
  const sessionId = request.cookies[cookieName];
  if (!sessionId) return null;
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
  if (!session || Date.parse(session.expires_at) < Date.now()) return null;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as UserRow | undefined;
  if (!user) return null;
  return { session, user };
}

export function requireAuth(db: DatabaseSync, request: FastifyRequest, reply: FastifyReply) {
  const auth = getSession(db, request);
  if (!auth) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return auth;
}

export function requireCsrf(db: DatabaseSync, request: FastifyRequest, reply: FastifyReply): boolean {
  const auth = getSession(db, request);
  if (!auth) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  const incoming = request.headers["x-csrf-token"];
  if (typeof incoming !== "string") {
    reply.code(403).send({ error: "missing_csrf" });
    return false;
  }
  const left = Buffer.from(incoming);
  const right = Buffer.from(auth.session.csrf_token);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    reply.code(403).send({ error: "invalid_csrf" });
    return false;
  }
  return true;
}
