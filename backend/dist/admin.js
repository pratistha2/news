"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminAuth = exports.safeEquals = exports.verifySecret = exports.DEFAULT_SESSION_IDLE_MS = exports.DEFAULT_SESSION_TTL_MS = void 0;
const crypto_1 = __importDefault(require("crypto"));
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
exports.DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
exports.DEFAULT_SESSION_IDLE_MS = 1000 * 60 * 60 * 2;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_LOCKOUT_MS = 1000 * 60 * 15;
const DEFAULT_MAX_ATTEMPTS_PER_IP = 20;
const DEFAULT_ATTEMPT_WINDOW_MS = 1000 * 60 * 15;
const SWEEP_INTERVAL_MS = 1000 * 60 * 5;
const deriveKey = (password, salt) => new Promise((resolve, reject) => {
    crypto_1.default.scrypt(password, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
        if (err) {
            reject(err);
            return;
        }
        resolve(derivedKey);
    });
});
/** Synchronous variant, used only during boot so no top-level await is needed. */
const deriveKeySync = (password, salt) => crypto_1.default.scryptSync(password, salt, SCRYPT_KEYLEN);
const hashSecretSync = (secret) => {
    const salt = crypto_1.default.randomBytes(SALT_BYTES).toString("hex");
    return `${salt}:${deriveKeySync(secret, salt).toString("hex")}`;
};
const verifySecret = async (secret, stored) => {
    const [salt, expected] = stored.split(":");
    if (!salt || !expected)
        return false;
    const actual = await deriveKey(secret, salt);
    const expectedBuf = Buffer.from(expected, "hex");
    if (expectedBuf.length !== actual.length)
        return false;
    return crypto_1.default.timingSafeEqual(actual, expectedBuf);
};
exports.verifySecret = verifySecret;
const safeEquals = (a, b) => {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    if (left.length !== right.length) {
        // Still burn a comparison so length is not leaked through timing.
        crypto_1.default.timingSafeEqual(left, left);
        return false;
    }
    return crypto_1.default.timingSafeEqual(left, right);
};
exports.safeEquals = safeEquals;
const hashToken = (token) => crypto_1.default.createHash("sha256").update(token).digest("hex");
const normalizeEmail = (value) => value.trim().toLowerCase();
class AdminAuth {
    constructor(input) {
        this.sessions = new Map();
        this.failuresByEmail = new Map();
        this.attemptsByIp = new Map();
        this.sweeper = null;
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
    static create(options) {
        const email = options.email ? normalizeEmail(options.email) : "";
        const storedHash = options.passwordHash?.trim() || "";
        const password = options.password ?? "";
        let secretHash = storedHash;
        if (!secretHash && password.length > 0)
            secretHash = hashSecretSync(password);
        // Always keep a decoy hash so a failed attempt costs the same scrypt work
        // whether or not the operator configured ADMIN_PASSWORD.
        const dummyHash = hashSecretSync(crypto_1.default.randomBytes(24).toString("hex"));
        const auth = new AdminAuth({
            email,
            secretHash,
            dummyHash,
            sessionTtlMs: options.sessionTtlMs ?? exports.DEFAULT_SESSION_TTL_MS,
            sessionIdleMs: options.sessionIdleMs ?? exports.DEFAULT_SESSION_IDLE_MS,
            maxFailures: options.maxFailures ?? DEFAULT_MAX_FAILURES,
            lockoutMs: options.lockoutMs ?? DEFAULT_LOCKOUT_MS,
            maxAttemptsPerIp: options.maxAttemptsPerIp ?? DEFAULT_MAX_ATTEMPTS_PER_IP,
            attemptWindowMs: options.attemptWindowMs ?? DEFAULT_ATTEMPT_WINDOW_MS,
        });
        auth.sweeper = setInterval(() => auth.sweep(), SWEEP_INTERVAL_MS);
        auth.sweeper.unref();
        return auth;
    }
    get configured() {
        return this.email.length > 0 && this.secretHash.length > 0;
    }
    get loginEmail() {
        return this.email;
    }
    sweep() {
        const now = Date.now();
        for (const [key, session] of this.sessions) {
            if (this.isExpired(session, now))
                this.sessions.delete(key);
        }
        for (const [key, bucket] of this.failuresByEmail) {
            if (bucket.resetAt <= now)
                this.failuresByEmail.delete(key);
        }
        for (const [key, bucket] of this.attemptsByIp) {
            if (bucket.resetAt <= now)
                this.attemptsByIp.delete(key);
        }
    }
    isExpired(session, now) {
        return (now - session.createdAt > this.sessionTtlMs ||
            now - session.lastSeenAt > this.sessionIdleMs);
    }
    registerIpAttempt(ip, now) {
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
    registerEmailFailure(email, now) {
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
    clearEmailFailures(email) {
        this.failuresByEmail.delete(email);
    }
    async login(input) {
        if (!this.configured)
            return { status: "unconfigured" };
        const now = Date.now();
        const retryAfterMs = this.registerIpAttempt(input.ip, now);
        if (retryAfterMs > 0)
            return { status: "throttled", retryAfterMs };
        const email = normalizeEmail(input.email);
        const locked = this.failuresByEmail.get(email);
        if (locked && locked.resetAt <= now)
            this.failuresByEmail.delete(email);
        else if (locked && locked.count >= this.maxFailures) {
            return { status: "locked", retryAfterMs: locked.resetAt - now };
        }
        const emailMatches = (0, exports.safeEquals)(email, this.email);
        const passwordMatches = await (0, exports.verifySecret)(input.password, this.secretHash);
        // Decoy so response time does not reveal whether the address exists.
        if (!emailMatches)
            await (0, exports.verifySecret)(input.password, this.dummyHash);
        if (!emailMatches || !passwordMatches) {
            this.registerEmailFailure(email, now);
            return { status: "invalid" };
        }
        this.clearEmailFailures(email);
        const token = crypto_1.default.randomBytes(32).toString("hex");
        this.sessions.set(hashToken(token), {
            email: this.email,
            createdAt: now,
            lastSeenAt: now,
        });
        return { status: "ok", token, email: this.email };
    }
    readSession(token) {
        if (typeof token !== "string" || token.length < 16)
            return null;
        const key = hashToken(token);
        const session = this.sessions.get(key);
        if (!session)
            return null;
        const now = Date.now();
        if (this.isExpired(session, now)) {
            this.sessions.delete(key);
            return null;
        }
        session.lastSeenAt = now;
        return session.email;
    }
    destroySession(token) {
        if (typeof token !== "string" || token.length < 16)
            return;
        this.sessions.delete(hashToken(token));
    }
    get activeSessions() {
        this.sweep();
        return this.sessions.size;
    }
    dispose() {
        if (this.sweeper)
            clearInterval(this.sweeper);
        this.sweeper = null;
    }
}
exports.AdminAuth = AdminAuth;
