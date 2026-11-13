import { createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@coldguard/shared';
import type { Collections } from './db.js';

export interface AuthUser {
  username: string;
  role: Role;
  displayName: string;
  groups: string[];
  /** Drivers (judges' phones) are scoped to exactly one truck. */
  deviceId?: string;
}

export interface AuthAgent {
  agentId: string;
  groups: string[];
  /** If set, the agent may only send readings for these devices (phone trucks). */
  deviceIds?: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    agent?: AuthAgent;
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function hashPassword(pw: string) {
  return bcrypt.hash(pw, 10);
}

// A fixed hash so unknown usernames cost the same as wrong passwords.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', 10);

export class AuthService {
  constructor(
    private col: Collections,
    private secret: string,
    private ttl: string,
  ) {}

  async login(username: string, password: string): Promise<{ token: string; user: AuthUser } | null> {
    const doc = await this.col.users.findOne({ _id: username });
    const ok = await bcrypt.compare(password, doc?.passwordHash ?? DUMMY_HASH);
    if (!doc || !ok) return null;
    const user: AuthUser = { username: doc._id, role: doc.role, displayName: doc.displayName, groups: doc.groups };
    const token = jwt.sign({ sub: user.username, role: user.role, groups: user.groups, name: user.displayName }, this.secret, {
      expiresIn: this.ttl as jwt.SignOptions['expiresIn'],
      algorithm: 'HS256',
    });
    return { token, user };
  }

  /** Short-lived token for an audience member driving one guest truck from a phone. */
  signDriver(deviceId: string, name: string, ttlSec: number): { token: string; user: AuthUser } {
    const user: AuthUser = { username: `driver:${deviceId}`, role: 'driver', displayName: name, groups: [], deviceId };
    const token = jwt.sign({ sub: user.username, role: 'driver', groups: [], name, dev: deviceId }, this.secret, { expiresIn: ttlSec, algorithm: 'HS256' });
    return { token, user };
  }

  verify(token: string): AuthUser | null {
    try {
      const p = jwt.verify(token, this.secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      if (typeof p.sub !== 'string' || !Array.isArray(p.groups)) return null;
      if (p.role === 'driver') {
        if (typeof p.dev !== 'string') return null;
        return { username: p.sub, role: 'driver', groups: [], displayName: String(p.name ?? p.sub), deviceId: p.dev };
      }
      if (p.role !== 'operator' && p.role !== 'viewer') return null;
      return { username: p.sub, role: p.role, groups: p.groups as string[], displayName: String(p.name ?? p.sub) };
    } catch {
      return null;
    }
  }

  /** Agent credential format: "<agentId>.<secret>". Only SHA-256(secret) is stored. */
  async verifyAgentKey(key: string | undefined): Promise<AuthAgent | null> {
    if (!key) return null;
    const dot = key.indexOf('.');
    if (dot <= 0) return null;
    const agentId = key.slice(0, dot);
    const secret = key.slice(dot + 1);
    const doc = await this.agentCache(agentId);
    if (!doc) return null;
    const a = Buffer.from(sha256(secret), 'hex');
    const b = Buffer.from(doc.secretSha256, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { agentId, groups: doc.groups };
  }

  private agents = new Map<string, { doc: { secretSha256: string; groups: string[] } | null; at: number }>();
  private async agentCache(agentId: string) {
    const hit = this.agents.get(agentId);
    if (hit && Date.now() - hit.at < 30_000) return hit.doc;
    const doc = await this.col.agents.findOne({ _id: agentId });
    const v = doc ? { secretSha256: doc.secretSha256, groups: doc.groups } : null;
    this.agents.set(agentId, { doc: v, at: Date.now() });
    return v;
  }

  // ---- Express middleware ---------------------------------------------

  requireUser = (req: Request, res: Response, next: NextFunction) => {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    const user = token ? this.verify(token) : null;
    if (!user) return void res.status(401).json({ error: 'unauthenticated' });
    req.user = user;
    next();
  };

  requireRole = (role: Role) => (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== role) return void res.status(403).json({ error: 'forbidden', need: role });
    next();
  };

  requireAgent = async (req: Request, res: Response, next: NextFunction) => {
    const h = req.headers.authorization;
    // A judge's phone streams its own truck's readings with its driver token.
    if (h?.startsWith('Bearer ')) {
      const u = this.verify(h.slice(7));
      if (u?.role !== 'driver' || !u.deviceId) return void res.status(401).json({ error: 'invalid driver token' });
      req.agent = { agentId: `phone:${u.deviceId}`, groups: [], deviceIds: [u.deviceId] };
      return next();
    }
    const key = h?.startsWith('Agent ') ? h.slice(6) : undefined;
    const agent = await this.verifyAgentKey(key).catch(() => null);
    if (!agent) return void res.status(401).json({ error: 'invalid agent credential' });
    req.agent = agent;
    next();
  };
}
