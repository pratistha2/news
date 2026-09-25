import crypto from "crypto";

export interface User {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

const users: User[] = [];
let sequence = 0;

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export type UserSession = { userId: string; createdAt: number };

export const userSessions = new Map<string, UserSession>();

interface PasswordResetToken {
  userId: string;
  expiresAt: number;
}

const passwordResetTokens = new Map<string, PasswordResetToken>();

const hashResetToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

const nextId = (): string => {
  sequence += 1;
  return `u-${Date.now().toString(36)}-${sequence}`;
};

const SCRYPT_KEYLEN = 64;

const deriveKey = (password: string, salt: string): Promise<string> =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey.toString("hex"));
    });
  });

export const normalizeEmail = (value: string): string =>
  value.trim().toLowerCase();

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isValidEmail = (value: string): boolean =>
  EMAIL_PATTERN.test(value.trim());

export const hashPassword = async (password: string): Promise<string> => {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await deriveKey(password, salt);
  return `${salt}:${derived}`;
};

export const verifyPassword = async (
  password: string,
  stored: string
): Promise<boolean> => {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = await deriveKey(password, salt);
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

export const createSession = (userId: string): string => {
  const token = crypto.randomBytes(32).toString("hex");
  userSessions.set(token, { userId, createdAt: Date.now() });
  return token;
};

export const destroySession = (token: string): void => {
  userSessions.delete(token);
};

export const findUserByEmail = (email: string): User | undefined =>
  users.find((u) => u.email === normalizeEmail(email));

export const createPasswordResetToken = (
  userId: string,
  ttlMs: number
): string => {
  for (const [tokenHash, reset] of passwordResetTokens) {
    if (reset.userId === userId || reset.expiresAt <= Date.now()) {
      passwordResetTokens.delete(tokenHash);
    }
  }

  const token = crypto.randomBytes(32).toString("hex");
  passwordResetTokens.set(hashResetToken(token), {
    userId,
    expiresAt: Date.now() + ttlMs,
  });
  return token;
};

const revokeUserSessions = (userId: string): void => {
  for (const [token, session] of userSessions) {
    if (session.userId === userId) userSessions.delete(token);
  }
};

export const resetUserPassword = async (
  token: string,
  password: string
): Promise<boolean> => {
  const tokenHash = hashResetToken(token);
  const reset = passwordResetTokens.get(tokenHash);
  if (!reset) return false;

  passwordResetTokens.delete(tokenHash);
  if (reset.expiresAt <= Date.now()) return false;

  const user = users.find((candidate) => candidate.id === reset.userId);
  if (!user) return false;

  user.passwordHash = await hashPassword(password);
  revokeUserSessions(user.id);
  return true;
};

export const createUser = async (input: {
  name: string;
  email: string;
  password: string;
}): Promise<User> => {
  const user: User = {
    id: nextId(),
    name: input.name.trim(),
    email: normalizeEmail(input.email),
    passwordHash: await hashPassword(input.password),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  return user;
};

export const getSessionUser = (token: string): User | undefined => {
  const session = userSessions.get(token);
  if (!session) return undefined;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    userSessions.delete(token);
    return undefined;
  }
  return users.find((u) => u.id === session.userId);
};

export const toPublicUser = (user: User): PublicUser => ({
  id: user.id,
  name: user.name,
  email: user.email,
  createdAt: user.createdAt,
});

export const listUsers = (): PublicUser[] => users.map(toPublicUser);

export const countUsers = (): number => users.length;

export const deleteUser = (id: string): boolean => {
  const index = users.findIndex((u) => u.id === id);
  if (index === -1) return false;
  users.splice(index, 1);
  revokeUserSessions(id);
  for (const [tokenHash, reset] of passwordResetTokens) {
    if (reset.userId === id) passwordResetTokens.delete(tokenHash);
  }
  return true;
};