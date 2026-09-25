"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteUser = exports.countUsers = exports.listUsers = exports.toPublicUser = exports.getSessionUser = exports.createUser = exports.resetUserPassword = exports.createPasswordResetToken = exports.findUserByEmail = exports.destroySession = exports.createSession = exports.verifyPassword = exports.hashPassword = exports.isValidEmail = exports.EMAIL_PATTERN = exports.normalizeEmail = exports.userSessions = void 0;
const crypto_1 = __importDefault(require("crypto"));
const users = [];
let sequence = 0;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
exports.userSessions = new Map();
const passwordResetTokens = new Map();
const hashResetToken = (token) => crypto_1.default.createHash("sha256").update(token).digest("hex");
const nextId = () => {
    sequence += 1;
    return `u-${Date.now().toString(36)}-${sequence}`;
};
const SCRYPT_KEYLEN = 64;
const deriveKey = (password, salt) => new Promise((resolve, reject) => {
    crypto_1.default.scrypt(password, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
        if (err) {
            reject(err);
            return;
        }
        resolve(derivedKey.toString("hex"));
    });
});
const normalizeEmail = (value) => value.trim().toLowerCase();
exports.normalizeEmail = normalizeEmail;
exports.EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (value) => exports.EMAIL_PATTERN.test(value.trim());
exports.isValidEmail = isValidEmail;
const hashPassword = async (password) => {
    const salt = crypto_1.default.randomBytes(16).toString("hex");
    const derived = await deriveKey(password, salt);
    return `${salt}:${derived}`;
};
exports.hashPassword = hashPassword;
const verifyPassword = async (password, stored) => {
    const [salt, expected] = stored.split(":");
    if (!salt || !expected)
        return false;
    const actual = await deriveKey(password, salt);
    const a = Buffer.from(actual, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length)
        return false;
    return crypto_1.default.timingSafeEqual(a, b);
};
exports.verifyPassword = verifyPassword;
const createSession = (userId) => {
    const token = crypto_1.default.randomBytes(32).toString("hex");
    exports.userSessions.set(token, { userId, createdAt: Date.now() });
    return token;
};
exports.createSession = createSession;
const destroySession = (token) => {
    exports.userSessions.delete(token);
};
exports.destroySession = destroySession;
const findUserByEmail = (email) => users.find((u) => u.email === (0, exports.normalizeEmail)(email));
exports.findUserByEmail = findUserByEmail;
const createPasswordResetToken = (userId, ttlMs) => {
    for (const [tokenHash, reset] of passwordResetTokens) {
        if (reset.userId === userId || reset.expiresAt <= Date.now()) {
            passwordResetTokens.delete(tokenHash);
        }
    }
    const token = crypto_1.default.randomBytes(32).toString("hex");
    passwordResetTokens.set(hashResetToken(token), {
        userId,
        expiresAt: Date.now() + ttlMs,
    });
    return token;
};
exports.createPasswordResetToken = createPasswordResetToken;
const revokeUserSessions = (userId) => {
    for (const [token, session] of exports.userSessions) {
        if (session.userId === userId)
            exports.userSessions.delete(token);
    }
};
const resetUserPassword = async (token, password) => {
    const tokenHash = hashResetToken(token);
    const reset = passwordResetTokens.get(tokenHash);
    if (!reset)
        return false;
    passwordResetTokens.delete(tokenHash);
    if (reset.expiresAt <= Date.now())
        return false;
    const user = users.find((candidate) => candidate.id === reset.userId);
    if (!user)
        return false;
    user.passwordHash = await (0, exports.hashPassword)(password);
    revokeUserSessions(user.id);
    return true;
};
exports.resetUserPassword = resetUserPassword;
const createUser = async (input) => {
    const user = {
        id: nextId(),
        name: input.name.trim(),
        email: (0, exports.normalizeEmail)(input.email),
        passwordHash: await (0, exports.hashPassword)(input.password),
        createdAt: new Date().toISOString(),
    };
    users.push(user);
    return user;
};
exports.createUser = createUser;
const getSessionUser = (token) => {
    const session = exports.userSessions.get(token);
    if (!session)
        return undefined;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        exports.userSessions.delete(token);
        return undefined;
    }
    return users.find((u) => u.id === session.userId);
};
exports.getSessionUser = getSessionUser;
const toPublicUser = (user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
});
exports.toPublicUser = toPublicUser;
const listUsers = () => users.map(exports.toPublicUser);
exports.listUsers = listUsers;
const countUsers = () => users.length;
exports.countUsers = countUsers;
const deleteUser = (id) => {
    const index = users.findIndex((u) => u.id === id);
    if (index === -1)
        return false;
    users.splice(index, 1);
    revokeUserSessions(id);
    for (const [tokenHash, reset] of passwordResetTokens) {
        if (reset.userId === id)
            passwordResetTokens.delete(tokenHash);
    }
    return true;
};
exports.deleteUser = deleteUser;
