import crypto from "crypto";

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
export const DEFAULT_SESSION_IDLE_MS = 1000 * 60 * 60 * 2;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_LOCKOUT_MS = 1000 * 60 * 15;
const DEFAULT_MAX_ATTEMPTS_PER_IP = 20;
const DEFAULT_ATTEMPT_WINDOW_MS = 1000 * 60 * 15;
const SWEEP_INTERVAL_MS = 1000 * 60 * 5;

const deriveKey = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey as Buffer);
    });
  });

/** Synchronous variant, used only during boot so no top-level await is needed. */
const deriveKeySync = (password: string, salt: string): Buffer =>
  crypto.scryptSync(password, salt, SCRYPT_KEYLEN);

const hashSecretSync = (secret: string): string => {
  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  return `${salt}:${deriveKeySync(secret, salt).toString("hex")}`;
};

export const verifySecret = async (
  secret: string,
  stored: string
): Promise<boolean> => {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = await deriveKey(secret, salt);
  const expectedBuf = Buffer.from(expected, "hex");
  if (expectedBuf.length !== actual.length) return false;
  return crypto.timingSafeEqual(actual, expectedBuf);
};

export const safeEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still burn a comparison so length is not leaked through timing.
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
};

const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

interface StoredSession {
  email: string;
  createdAt: number;
  lastSeenAt: number;
}

interface FailureBucket {
  count: number;
  resetAt: number;
}

export interface AdminAuthOptions {
  email?: string;
  password?: string;
  passwordHash?: string;
  sessionTtlMs?: number;
  sessionIdleMs?: number;
  maxFailures?: number;
  lockoutMs?: number;
  maxAttemptsPerIp?: number;
  attemptWindowMs?: number;
}

export type LoginResult =
  | { status: "unconfigured" }
  | { status: "invalid" }
  | { status: "locked"; retryAfterMs: number }
  | { status: "throttled"; retryAfterMs: number }
  | { status: "ok"; token: string; email: string };

export class AdminAuth {
  private readonly email: string;
  private readonly secretHash: string;
  private readonly dummyHash: string;
  private readonly sessions = new Map<string, StoredSession>();
  private readonly failuresByEmail = new Map<string, FailureBucket>();
  private readonly attemptsByIp = new Map<string, FailureBucket>();
  private readonly sessionTtlMs: number;
  private readonly sessionIdleMs: number;
  private readonly maxFailures: number;
  private readonly lockoutMs: number;
  private readonly maxAttemptsPerIp: number;
  private readonly attemptWindowMs: number;
  private sweeper: NodeJS.Timeout | null = null;

  private constructor(input: {
    email: string;
    secretHash: string;
    dummyHash: string;
    sessionTtlMs: number;
    sessionIdleMs: number;
    maxFailures: number;
    lockoutMs: number;
    maxAttemptsPerIp: number;
    attemptWindowMs: number;
  }) {
    this.email = input.email;
    this.secretHash = input.secretHash;
    this.dummyHash = input.dummyHash;
    this.sessionTtlMs = input.sessionTtlMs;
    this.sessionIdleMs = input.sessionIdleMs;
    this.maxFailures = input.maxFailures;
    this.lockoutMs = input.lockoutMs;
    this.maxAttemptsPerIp = input.maxAttemptsPerIp;
    this.attemptWindowMs = input.attemptWindowMs;
  }

  static create(options: AdminAuthOptions): AdminAuth {
    const email = options.email ? normalizeEmail(options.email) : "";
    const storedHash = options.passwordHash?.trim() || "";
    const password = options.password ?? "";

    let secretHash = storedHash;
    if (!secretHash && password.length > 0) secretHash = hashSecretSync(password);

    // Always keep a decoy hash so a failed attempt costs the same scrypt work
    // whether or not the operator configured ADMIN_PASSWORD.
    const dummyHash = hashSecretSync(crypto.randomBytes(24).toString("hex"));

    const auth = new AdminAuth({
      email,
      secretHash,
      dummyHash,
      sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      sessionIdleMs: options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS,
      maxFailures: options.maxFailures ?? DEFAULT_MAX_FAILURES,
      lockoutMs: options.lockoutMs ?? DEFAULT_LOCKOUT_MS,
      maxAttemptsPerIp:
        options.maxAttemptsPerIp ?? DEFAULT_MAX_ATTEMPTS_PER_IP,
      attemptWindowMs: options.attemptWindowMs ?? DEFAULT_ATTEMPT_WINDOW_MS,
    });

    auth.sweeper = setInterval(() => auth.sweep(), SWEEP_INTERVAL_MS);
    auth.sweeper.unref();
    return auth;
  }

  get configured(): boolean {
    return this.email.length > 0 && this.secretHash.length > 0;
  }

  get loginEmail(): string {
    return this.email;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (this.isExpired(session, now)) this.sessions.delete(key);
    }
    for (const [key, bucket] of this.failuresByEmail) {
      if (bucket.resetAt <= now) this.failuresByEmail.delete(key);
    }
    for (const [key, bucket] of this.attemptsByIp) {
      if (bucket.resetAt <= now) this.attemptsByIp.delete(key);
    }
  }

  private isExpired(session: StoredSession, now: number): boolean {
    return (
      now - session.createdAt > this.sessionTtlMs ||
      now - session.lastSeenAt > this.sessionIdleMs
    );
  }

  private registerIpAttempt(ip: string, now: number): number {
    const existing = this.attemptsByIp.get(ip);
    if (!existing || existing.resetAt <= now) {
      this.attemptsByIp.set(ip, { count: 1, resetAt: now + this.attemptWindowMs });
      return 0;
    }
    existing.count += 1;
    if (existing.count > this.maxAttemptsPerIp) {
      return Math.max(0, existing.resetAt - now);
    }
    return 0;
  }

  private registerEmailFailure(email: string, now: number): void {
    const existing = this.failuresByEmail.get(email);
    if (!existing || existing.resetAt <= now) {
      this.failuresByEmail.set(email, {
        count: 1,
        resetAt: now + this.lockoutMs,
      });
      return;
    }
    existing.count += 1;
  }

  private clearEmailFailures(email: string): void {
    this.failuresByEmail.delete(email);
  }

  async login(input: {
    email: string;
    password: string;
    ip: string;
  }): Promise<LoginResult> {
    if (!this.configured) return { status: "unconfigured" };

    const now = Date.now();
    const retryAfterMs = this.registerIpAttempt(input.ip, now);
    if (retryAfterMs > 0) return { status: "throttled", retryAfterMs };

    const email = normalizeEmail(input.email);
    const locked = this.failuresByEmail.get(email);
    if (locked && locked.resetAt <= now) this.failuresByEmail.delete(email);
    else if (locked && locked.count >= this.maxFailures) {
      return { status: "locked", retryAfterMs: locked.resetAt - now };
    }

    const emailMatches = safeEquals(email, this.email);
    const passwordMatches = await verifySecret(input.password, this.secretHash);

    // Decoy so response time does not reveal whether the address exists.
    if (!emailMatches) await verifySecret(input.password, this.dummyHash);

    if (!emailMatches || !passwordMatches) {
      this.registerEmailFailure(email, now);
      return { status: "invalid" };
    }

    this.clearEmailFailures(email);
    const token = crypto.randomBytes(32).toString("hex");
    this.sessions.set(hashToken(token), {
      email: this.email,
      createdAt: now,
      lastSeenAt: now,
    });
    return { status: "ok", token, email: this.email };
  }

  readSession(token: unknown): string | null {
    if (typeof token !== "string" || token.length < 16) return null;
    const key = hashToken(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    const now = Date.now();
    if (this.isExpired(session, now)) {
      this.sessions.delete(key);
      return null;
    }
    session.lastSeenAt = now;
    return session.email;
  }

  destroySession(token: unknown): void {
    if (typeof token !== "string" || token.length < 16) return;
    this.sessions.delete(hashToken(token));
  }

  get activeSessions(): number {
    this.sweep();
    return this.sessions.size;
  }

  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}
