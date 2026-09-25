import "dotenv/config";
import crypto from "crypto";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import { news, NewsItem } from "./data/news";
import { personalities, categories, Personality } from "./data/personalities";
import { translitVariants, dictionaryExpansions } from "./translit";
import { generatePoll } from "./poll";
import { castVote, getPollResults, listAdminPolls } from "./data/polls";
import {
  addSubmission,
  approveSubmission,
  getSubmission,
  listSubmissions,
  rejectSubmission,
} from "./data/submissions";
import {
  countUsers,
  createPasswordResetToken,
  createSession,
  createUser,
  deleteUser,
  destroySession,
  findUserByEmail,
  getSessionUser,
  isValidEmail,
  listUsers,
  normalizeEmail,
  resetUserPassword,
  toPublicUser,
  verifyPassword,
} from "./data/users";

const app = express();
const PORT = process.env.PORT || 4000;

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const ORIGIN = process.env.SITE_URL ?? "http://localhost:3000";

const configuredSmtpPort = Number(process.env.SMTP_PORT ?? 587);
const SMTP_PORT =
  Number.isInteger(configuredSmtpPort) &&
  configuredSmtpPort > 0 &&
  configuredSmtpPort <= 65_535
    ? configuredSmtpPort
    : 587;
const SMTP_SECURE =
  process.env.SMTP_SECURE === undefined
    ? SMTP_PORT === 465
    : /^(1|true|yes)$/i.test(process.env.SMTP_SECURE);
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const MAIL_FROM = process.env.MAIL_FROM;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "pratistha.sapkota123@gmail.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin123";

const adminSessions = new Map<string, { createdAt: number }>();

let newsFeed: NewsItem[] = [...news];
let newsSeq = 0;

app.disable("x-powered-by");

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  );
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: https://picsum.photos; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"
  );
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.length === 0) {
        callback(null, true);
        return;
      }
      if (ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS not allowed for this origin"));
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    maxAge: 600,
  })
);

app.use(express.json({ limit: "100kb" }));

const WINDOW_MS = 60_000;

const ipKey = (req: Request): string =>
  req.ip ||
  req.socket.remoteAddress ||
  "unknown";

const RATE_LIMIT = Number(process.env.RATE_LIMIT ?? 120);
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction) {
  const key = ipKey(req);
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  bucket.count += 1;

  if (bucket.count > RATE_LIMIT) {
    res.status(429).json({ message: "धेरै धेरै अनुरोध भयो। केही बेरपछि पुनः प्रयास गर्नुहोस्।" });
    return;
  }

  if (rateBuckets.size > 5000) {
    for (const [k, b] of rateBuckets) {
      if (b.resetAt < now) rateBuckets.delete(k);
    }
  }

  next();
}

app.use("/api", rateLimit);

const AUTH_WINDOW_MS = 5 * 60_000;
const AUTH_RATE_LIMIT = Number(process.env.AUTH_RATE_LIMIT ?? 20);
const authBuckets = new Map<string, { count: number; resetAt: number }>();

function authRateLimit(req: Request, res: Response, next: NextFunction) {
  const key = ipKey(req);
  const now = Date.now();
  const bucket = authBuckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    authBuckets.set(key, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    next();
    return;
  }

  bucket.count += 1;

  if (bucket.count > AUTH_RATE_LIMIT) {
    res.status(429).json({ message: "धेरै पटक प्रयास गरियो। पाँच मिनेटपछि फेरि प्रयास गर्नुहोस्।" });
    return;
  }

  next();
}

const clampInt = (value: string | undefined, min: number, max: number, fallback: number): number => {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const PASSWORD_RESET_TTL_MINUTES = clampInt(
  process.env.PASSWORD_RESET_TTL_MINUTES,
  5,
  120,
  30
);

const smtpTransport =
  SMTP_HOST && MAIL_FROM
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        ...(SMTP_USER && SMTP_PASSWORD
          ? { auth: { user: SMTP_USER, pass: SMTP_PASSWORD } }
          : {}),
      })
    : null;

const sendPasswordResetEmail = async (input: {
  to: string;
  name: string;
  token: string;
}): Promise<void> => {
  if (!smtpTransport || !MAIL_FROM) {
    throw new Error("SMTP is not configured");
  }

  const resetUrl = new URL("/reset-password", ORIGIN);
  resetUrl.searchParams.set("token", input.token);

  await smtpTransport.sendMail({
    from: MAIL_FROM,
    to: input.to,
    subject: "Reset your news account password",
    text: [
      `Hello ${input.name},`,
      "",
      "Use the link below to reset your password.",
      `This link expires in ${PASSWORD_RESET_TTL_MINUTES} minutes.`,
      "",
      resetUrl.toString(),
      "",
      "If you did not request this, you can ignore this email.",
    ].join("\n"),
  });
};

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    message: "न्युज सर्भर चालू छ",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/personalities", (_req: Request, res: Response) => {
  res.json({ data: personalities });
});

app.get("/api/categories", (_req: Request, res: Response) => {
  res.json({ data: categories });
});

app.get("/api/poll", (_req: Request, res: Response) => {
  res.json({ data: generatePoll() });
});

app.get("/api/polls/:id/results", (req: Request, res: Response) => {
  const results = getPollResults(req.params.id);
  if (!results) {
    res.status(404).json({ message: "मतदान फेला परेन।" });
    return;
  }
  res.json({ data: results });
});

app.post("/api/polls/:id/vote", (req: Request, res: Response) => {
  const optionId = cleanText((req.body ?? {}).optionId, 100);
  if (!optionId) {
    res.status(400).json({ message: "मतदान विकल्प आवश्यक छ।" });
    return;
  }
  const voterKey = crypto
    .createHash("sha256")
    .update(ipKey(req))
    .digest("hex");
  const outcome = castVote(req.params.id, optionId, voterKey);
  if (!outcome.ok) {
    res.status(400).json({ message: outcome.error });
    return;
  }
  res.status(201).json({
    data: outcome.data,
    message: outcome.alreadyVoted
      ? "तपाईंले पहिल्यै मतदान गर्नुभएको छ।"
      : "मतदान सफल भयो।",
  });
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const parseDateBoundary = (value: string, endOfDay: boolean): number => {
  const text = typeof value === "string" ? value.trim().slice(0, 10) : "";
  if (!DATE_PATTERN.test(text)) return NaN;
  const time = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  return new Date(`${text}${time}`).getTime();
};

const slugMatches = (slug: string, q: string): boolean =>
  slug.split("-").some((part) => part.length >= 3 && part.startsWith(q));

const filterNews = (req: Request): NewsItem[] => {
  const q = (req.query.q as string || "").toLowerCase().trim().slice(0, 200);
  const personality = (req.query.personality as string || "").toLowerCase();
  const category = (req.query.category as string || "").toLowerCase();
  const from = parseDateBoundary(req.query.from as string || "", false);
  const to = parseDateBoundary(req.query.to as string || "", true);

  let result = newsFeed;

  if (!Number.isNaN(from)) {
    result = result.filter((n) => new Date(n.publishedAt).getTime() >= from);
  }

  if (!Number.isNaN(to)) {
    result = result.filter((n) => new Date(n.publishedAt).getTime() <= to);
  }

  if (personality) {
    result = result.filter((n) => n.personalities.includes(personality));
  }

  if (category) {
    result = result.filter((n) => n.category === category);
  }

  if (q) {
    const variants = new Set<string>();
    translitVariants(q).forEach((v) => {
      if (v) variants.add(v);
    });
    dictionaryExpansions(q).forEach((v) => {
      if (v) variants.add(v);
    });
    q.split(/\s+/).forEach((token) => {
      translitVariants(token).forEach((v) => {
        if (v) variants.add(v);
      });
    });

    const matchedPersonalitySlugs = new Set<string>();
    for (const variant of variants) {
      for (const p of personalities) {
        if (p.name.toLowerCase().includes(variant)) {
          matchedPersonalitySlugs.add(p.slug);
        }
      }
    }

    result = result.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.summary.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.categoryName.toLowerCase().includes(q) ||
        slugMatches(n.category, q) ||
        n.personalities.some((p) => slugMatches(p, q)) ||
        n.personalities.some((p) => matchedPersonalitySlugs.has(p)) ||
        [...variants].some(
          (v) =>
            n.title.toLowerCase().includes(v) ||
            n.summary.toLowerCase().includes(v) ||
            n.content.toLowerCase().includes(v) ||
            n.categoryName.toLowerCase().includes(v)
        )
    );
  }

  return result;
};

app.get("/api/news", (req: Request, res: Response) => {
  let result = filterNews(req);

  const total = result.length;

  const page = clampInt(req.query.page as string, 1, 100000, 1);
  const limit = clampInt(req.query.limit as string, 1, 50, 20);
  const start = (page - 1) * limit;
  result = result.slice(start, start + limit);

  const countByCategory: Record<string, number> = {};
  newsFeed.forEach((n) => {
    countByCategory[n.category] = (countByCategory[n.category] || 0) + 1;
  });

  res.json({
    total,
    page,
    limit,
    countByCategory,
    data: result,
  });
});

app.get("/api/news/featured", (req: Request, res: Response) => {
  const excludeCategory = (req.query.excludeCategory as string || "").toLowerCase();
  const excludePersonality = (req.query.excludePersonality as string || "").toLowerCase();

  const sorted = [...newsFeed].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );

  const picked: NewsItem[] = [];
  const seen = new Set<string>();

  const push = (item: NewsItem) => {
    if (seen.has(item.id)) return;
    if (excludeCategory && item.category === excludeCategory) return;
    if (excludePersonality && item.personalities.includes(excludePersonality)) return;
    seen.add(item.id);
    picked.push(item);
  };

  personalities.forEach((p) => {
    const item = sorted.find((n) => n.personalities.includes(p.slug));
    if (item) push(item);
  });

  categories.forEach((c) => {
    let slot = 0;
    for (const n of sorted) {
      if (slot >= 3) break;
      if (n.category !== c.slug) continue;
      if (seen.has(n.id)) continue;
      push(n);
      slot += 1;
    }
  });

  sorted.forEach((n) => {
    if (picked.length >= 10) return;
    push(n);
  });

  res.json({ data: picked });
});

app.get("/api/news/related", (req: Request, res: Response) => {
  const category = req.query.category as string;
  const excludeId = req.query.excludeId as string;
  const categoryNews = newsFeed.filter(
    (n) => n.category === category && n.id !== excludeId
  );
  const otherNews = newsFeed.filter(
    (n) => n.category !== category && n.id !== excludeId
  );
  res.json({
    category: categoryNews.slice(0, 6),
    other: otherNews.slice(0, 6),
  });
});

app.get("/api/news/:id", (req: Request, res: Response) => {
  const item = newsFeed.find((n) => n.id === req.params.id);
  if (!item) {
    res.status(404).json({ message: "समाचार फेला परेन" });
    return;
  }
  res.json({ data: item });
});

app.get("/api/news/:id/timeline", (req: Request, res: Response) => {
  const item = newsFeed.find((n) => n.id === req.params.id);
  if (!item) {
    res.status(404).json({ message: "समाचार फेला परेन" });
    return;
  }

  const sharesPersonality = item.personalities.length > 0
    ? newsFeed.filter(
        (n) =>
          n.id !== item.id &&
          n.personalities.some((p) => item.personalities.includes(p))
      )
    : [];
  const pool =
    sharesPersonality.length > 0
      ? sharesPersonality
      : newsFeed.filter(
          (n) => n.category === item.category && n.id !== item.id
        );

  const timeline = [...pool, item].sort(
    (a, b) =>
      new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime()
  );
  res.json({ data: timeline });
});

const cleanText = (value: unknown, max: number): string => {
  const text = typeof value === "string" ? value.trim() : "";
  return text.slice(0, max);
};

const isValidImageUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
};

const requireUser = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers["x-user-token"];
  if (typeof token !== "string" || !getSessionUser(token)) {
    res.status(401).json({ message: "प्रवेश गरिएको सत्र मिलेन। फेरि प्रवेश गर्नुहोस्।" });
    return;
  }
  next();
};

const currentUser = (req: Request) =>
  getSessionUser(req.headers["x-user-token"] as string);

app.post("/api/submissions", requireUser, (req: Request, res: Response) => {
  const { title, summary, content, image, category } = req.body ?? {};

  const cleanTitle = cleanText(title, 200);
  const cleanSummary = cleanText(summary, 500);
  const cleanContent = cleanText(content, 10000);
  const cleanImage = cleanText(image, 2000);
  const cleanCategory = cleanText(category, 100).toLowerCase();

  if (!cleanTitle) {
    res.status(400).json({ message: "समाचारको शीर्षक आवश्यक छ।" });
    return;
  }
  if (!cleanSummary) {
    res.status(400).json({ message: "समाचारको विवरण आवश्यक छ।" });
    return;
  }
  if (!isValidImageUrl(cleanImage)) {
    res.status(400).json({ message: "फोटोको ठीक (https) URL आवश्यक छ।" });
    return;
  }
  const categoryItem = categories.find((c) => c.slug === cleanCategory);
  if (!categoryItem) {
    res.status(400).json({ message: "वैध विधा छान्नुहोस्।" });
    return;
  }

  const submission = addSubmission({
    title: cleanTitle,
    summary: cleanSummary,
    content: cleanContent,
    image: cleanImage,
    category: categoryItem.slug,
    submittedBy: currentUser(req)?.email,
  });

  res.status(201).json({
    data: submission,
    message: "समाचार पठाइयो। प्रशासकले जाँचेपछि मात्र सार्वजनिक हुनेछ।",
  });
});

app.get("/api/submissions/:id", requireUser, (req: Request, res: Response) => {
  const submission = getSubmission(req.params.id);
  if (!submission) {
    res.status(404).json({ message: "पठाइएको समाचार फेला परेन" });
    return;
  }
  const owner = currentUser(req)?.email;
  if (submission.submittedBy && submission.submittedBy !== owner) {
    res.status(403).json({ message: "तपाईंले पठाएको समाचार मात्र हेर्न सकिन्छ।" });
    return;
  }
  res.json({ data: submission });
});

const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers["x-admin-token"];
  if (typeof token !== "string" || !adminSessions.has(token)) {
    res.status(401).json({ message: "प्रशासक सत्र मिलेन। फेरि प्रवेश गर्नुहोस्।" });
    return;
  }
  next();
};

app.post("/api/auth/register", authRateLimit, async (req: Request, res: Response) => {
  const { name, email, password } = req.body ?? {};

  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ message: "पूरा नाम आवश्यक छ।" });
    return;
  }
  if (name.trim().length > 100) {
    res.status(400).json({ message: "नाम धेरै लामो छ।" });
    return;
  }
  if (typeof email !== "string" || !isValidEmail(email)) {
    res.status(400).json({ message: "वैध इमेल ठेगाना आवश्यक छ।" });
    return;
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 200) {
    res.status(400).json({ message: "पासवर्ड कम्तीमा ८ अक्षरको हुनुपर्छ।" });
    return;
  }
  if (findUserByEmail(email)) {
    res.status(409).json({ message: "यो इमेलबाट खाता पहिल्यै बनाइएको छ। प्रवेश गर्नुहोस्।" });
    return;
  }

  try {
    const user = await createUser({
      name: name.trim(),
      email: normalizeEmail(email),
      password,
    });
    const token = createSession(user.id);
    res.status(201).json({
      data: { token, user: toPublicUser(user) },
      message: "खाता सफलतापूर्वक बनाइयो।",
    });
  } catch {
    res.status(500).json({ message: "खाता बनाउन सकिएन। पछि पुनः प्रयास गर्नुहोस्।" });
  }
});

app.post("/api/auth/login", authRateLimit, async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== "string" || !isValidEmail(email)) {
    res.status(400).json({ message: "वैध इमेल ठेगाना आवश्यक छ।" });
    return;
  }
  if (typeof password !== "string" || !password) {
    res.status(400).json({ message: "पासवर्ड आवश्यक छ।" });
    return;
  }

  const user = findUserByEmail(email);
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;

  if (!user || !valid) {
    res.status(401).json({ message: "इमेल वा पासवर्ड गलत छ।" });
    return;
  }

  const token = createSession(user.id);
  res.json({
    data: { token, user: toPublicUser(user) },
    message: "फेरि स्वागत छ, " + user.name.split(" ")[0] + "।",
  });
});

app.post("/api/auth/forgot-password", authRateLimit, async (req: Request, res: Response) => {
  const { email } = req.body ?? {};
  const responseMessage =
    "If an account exists for that email, a password reset link has been sent.";

  if (typeof email !== "string" || !isValidEmail(email)) {
    res.status(400).json({ message: "वैध इमेल ठेगाना आवश्यक छ।" });
    return;
  }

  const user = findUserByEmail(email);
  if (user) {
    try {
      const token = createPasswordResetToken(
        user.id,
        PASSWORD_RESET_TTL_MINUTES * 60_000
      );
      await sendPasswordResetEmail({ to: user.email, name: user.name, token });
    } catch {
      console.error("Password reset email could not be sent. Check SMTP configuration.");
    }
  }

  res.status(202).json({ message: responseMessage });
});

app.post("/api/auth/reset-password", authRateLimit, async (req: Request, res: Response) => {
  const { token, password } = req.body ?? {};
  const resetToken = typeof token === "string" ? token.trim() : "";

  if (!resetToken || resetToken.length > 256) {
    res.status(400).json({ message: "पासवर्ड रिसेट लिंक अमान्य वा म्याद सकिएको छ।" });
    return;
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 200) {
    res.status(400).json({ message: "पासवर्ड कम्तीमा ८ अक्षरको हुनुपर्छ।" });
    return;
  }

  try {
    const reset = await resetUserPassword(resetToken, password);
    if (!reset) {
      res.status(400).json({ message: "पासवर्ड रिसेट लिंक अमान्य वा म्याद सकिएको छ।" });
      return;
    }

    res.json({ message: "पासवर्ड सफलतापूर्वक परिवर्तन भयो।" });
  } catch {
    res.status(500).json({ message: "पासवर्ड परिवर्तन गर्न सकिएन। पछि पुनः प्रयास गर्नुहोस्।" });
  }
});

app.post("/api/auth/logout", requireUser, (req: Request, res: Response) => {
  destroySession(req.headers["x-user-token"] as string);
  res.json({ message: "सत्र समाप्त भयो।" });
});

app.get("/api/auth/me", requireUser, (req: Request, res: Response) => {
  const user = currentUser(req);
  res.json({ data: toPublicUser(user as NonNullable<typeof user>) });
});

app.post("/api/admin/login", (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ message: "इमेल र पासवर्ड आवश्यक छ।" });
    return;
  }
  if (email.trim().toLowerCase() !== ADMIN_EMAIL.toLowerCase() || password !== ADMIN_PASSWORD) {
    res.status(401).json({ message: "इमेल वा पासवर्ड गलत छ।" });
    return;
  }
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, { createdAt: Date.now() });
  res.json({ data: { token, email: ADMIN_EMAIL }, message: "प्रशासनमा स्वागत छ।" });
});

app.post("/api/admin/logout", requireAdmin, (req: Request, res: Response) => {
  const token = req.headers["x-admin-token"] as string;
  adminSessions.delete(token);
  res.json({ message: "सत्र समाप्त भयो।" });
});

app.get("/api/admin/stats", requireAdmin, (_req: Request, res: Response) => {
  const submissions = listSubmissions("all");
  const submissionCounts = { pending: 0, approved: 0, rejected: 0 };
  submissions.forEach((s) => {
    submissionCounts[s.status] += 1;
  });
  res.json({
    data: {
      news: newsFeed.length,
      submissions: submissionCounts,
      categories: categories.length,
      personalities: personalities.length,
      users: countUsers(),
    },
  });
});

app.get("/api/admin/polls", requireAdmin, (_req: Request, res: Response) => {
  const polls = listAdminPolls();
  res.json({ data: polls, total: polls.length });
});

app.get("/api/admin/users", requireAdmin, (_req: Request, res: Response) => {
  const users = listUsers();
  res.json({ data: users, total: users.length });
});

app.delete("/api/admin/users/:id", requireAdmin, (req: Request, res: Response) => {
  if (!deleteUser(req.params.id)) {
    res.status(404).json({ message: "प्रयोगकर्ता फेला परेन।" });
    return;
  }
  res.json({ message: "प्रयोगकर्ता हटाइयो।" });
});

app.get("/api/admin/submissions", requireAdmin, (req: Request, res: Response) => {
  const status = (req.query.status as string || "pending") as
    | "pending"
    | "approved"
    | "rejected"
    | "all";
  res.json({ data: listSubmissions(status) });
});

app.post(
  "/api/admin/submissions/:id/approve",
  requireAdmin,
  (req: Request, res: Response) => {
    const result = approveSubmission(req.params.id);
    if (!result) {
      res.status(404).json({ message: "पठाइएको समाचार फेला परेन वा सकिनसकेको छैन।" });
      return;
    }
    newsFeed.unshift(result.item);
    res.json({ data: result.submission, message: "समाचार स्वीकृत गरी सार्वजनिक गरियो।" });
  }
);

app.post(
  "/api/admin/submissions/:id/reject",
  requireAdmin,
  (req: Request, res: Response) => {
    const submission = rejectSubmission(req.params.id);
    if (!submission) {
      res.status(404).json({ message: "पठाइएको समाचार फेला परेन वा सकिनसकेको छैन।" });
      return;
    }
    res.json({ data: submission, message: "समाचार अस्वीकृत गरियो।" });
  }
);

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const parseNewsInput = (body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    title: cleanText(b.title, 200),
    summary: cleanText(b.summary, 500),
    content: cleanText(b.content, 10000),
    category: cleanText(b.category, 100).toLowerCase(),
    image: cleanText(b.image, 2000),
    personalities: Array.isArray(b.personalities)
      ? Array.from(new Set((b.personalities as unknown[]).map((p) => cleanText(p, 100).toLowerCase()).filter(Boolean)))
      : [],
    publishedAt:
      typeof b.publishedAt === "string" && !Number.isNaN(Date.parse(b.publishedAt))
        ? new Date(b.publishedAt).toISOString()
        : "",
  };
};

const newsValidationError = (input: ReturnType<typeof parseNewsInput>): string | null => {
  if (!input.title) return "समाचारको शीर्षक आवश्यक छ।";
  if (!input.summary) return "समाचारको विवरण आवश्यक छ।";
  if (!isValidImageUrl(input.image)) return "फोटोको ठीक (https) URL आवश्यक छ।";
  if (!categories.some((c) => c.slug === input.category)) return "वैध विधा छान्नुहोस्।";
  return null;
};

const validPersonalitySlugs = (slugs: string[]): string[] =>
  slugs.filter((slug) => personalities.some((p) => p.slug === slug)).slice(0, 8);

const categoryNameFor = (slug: string): string =>
  categories.find((c) => c.slug === slug)?.name ?? slug;

const nextNewsId = (): string => {
  newsSeq += 1;
  return `n-${Date.now().toString(36)}-${newsSeq}`;
};

app.get("/api/admin/news", requireAdmin, (_req: Request, res: Response) => {
  const sorted = [...newsFeed].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );
  res.json({ data: sorted, total: sorted.length });
});

app.post("/api/admin/news", requireAdmin, (req: Request, res: Response) => {
  const input = parseNewsInput(req.body);
  const error = newsValidationError(input);
  if (error) {
    res.status(400).json({ message: error });
    return;
  }
  const item: NewsItem = {
    id: nextNewsId(),
    title: input.title,
    summary: input.summary,
    content: input.content || input.summary,
    category: input.category,
    categoryName: categoryNameFor(input.category),
    personalities: validPersonalitySlugs(input.personalities),
    image: input.image,
    publishedAt: input.publishedAt || new Date().toISOString(),
  };
  newsFeed.unshift(item);
  res.status(201).json({ data: item, message: "समाचार सिर्जना गरियो।" });
});

app.put("/api/admin/news/:id", requireAdmin, (req: Request, res: Response) => {
  const item = newsFeed.find((n) => n.id === req.params.id);
  if (!item) {
    res.status(404).json({ message: "समाचार फेला परेन।" });
    return;
  }
  const input = parseNewsInput(req.body);
  if (input.title) item.title = input.title;
  if (input.summary) item.summary = input.summary;
  if (input.content) item.content = input.content;
  if (input.image) {
    if (!isValidImageUrl(input.image)) {
      res.status(400).json({ message: "फोटोको ठीक (https) URL आवश्यक छ।" });
      return;
    }
    item.image = input.image;
  }
  if (input.category) {
    if (!categories.some((c) => c.slug === input.category)) {
      res.status(400).json({ message: "वैध विधा छान्नुहोस्।" });
      return;
    }
    item.category = input.category;
    item.categoryName = categoryNameFor(input.category);
  }
  if (input.personalities.length > 0 || Array.isArray((req.body ?? {}).personalities)) {
    item.personalities = validPersonalitySlugs(input.personalities);
  }
  if (input.publishedAt) item.publishedAt = input.publishedAt;
  res.json({ data: item, message: "समाचार अद्यावधिक गरियो।" });
});

app.delete("/api/admin/news/:id", requireAdmin, (req: Request, res: Response) => {
  const index = newsFeed.findIndex((n) => n.id === req.params.id);
  if (index === -1) {
    res.status(404).json({ message: "समाचार फेला परेन।" });
    return;
  }
  const [removed] = newsFeed.splice(index, 1);
  res.json({ data: removed, message: "समाचार हटाइयो।" });
});

const personalityFromBody = (body: unknown, role: boolean) => {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    slug: cleanText(b.slug, 100).toLowerCase(),
    name: cleanText(b.name, 100),
    role: role ? cleanText(b.role, 200) : "",
    description: cleanText(b.description, 500),
  };
};

app.post("/api/admin/categories", requireAdmin, (req: Request, res: Response) => {
  const input = personalityFromBody(req.body, false);
  if (!input.slug || !SLUG_PATTERN.test(input.slug)) {
    res.status(400).json({ message: "मिल्दो चिह्न (slug) आवश्यक छ, जस्तै: technology।" });
    return;
  }
  if (!input.name) {
    res.status(400).json({ message: "विधाको नाम आवश्यक छ।" });
    return;
  }
  if (categories.some((c) => c.slug === input.slug)) {
    res.status(400).json({ message: "यो विधा पहिल्यै अवस्थित छ।" });
    return;
  }
  const created: Personality = { slug: input.slug, name: input.name, role: "", description: input.description };
  categories.push(created);
  res.status(201).json({ data: created, message: "विधा थपियो।" });
});

app.put("/api/admin/categories/:slug", requireAdmin, (req: Request, res: Response) => {
  const target = categories.find((c) => c.slug === req.params.slug);
  if (!target) {
    res.status(404).json({ message: "विधा फेला परेन।" });
    return;
  }
  const input = personalityFromBody(req.body, false);
  if ((req.body as Record<string, unknown>).name !== undefined && !input.name) {
    res.status(400).json({ message: "विधाको नाम आवश्यक छ।" });
    return;
  }
  if (input.name) target.name = input.name;
  target.description = input.description;
  newsFeed.forEach((n) => {
    if (n.category === target.slug) n.categoryName = target.name;
  });
  res.json({ data: target, message: "विधा अद्यावधिक गरियो।" });
});

app.delete("/api/admin/categories/:slug", requireAdmin, (req: Request, res: Response) => {
  const index = categories.findIndex((c) => c.slug === req.params.slug);
  if (index === -1) {
    res.status(404).json({ message: "विधा फेला परेन।" });
    return;
  }
  if (newsFeed.some((n) => n.category === req.params.slug)) {
    res.status(400).json({ message: "यो विधामा समाचारहरू छन्। ती सारेर पछि मात्र मेटाउन सकिन्छ।" });
    return;
  }
  const [removed] = categories.splice(index, 1);
  res.json({ data: removed, message: "विधा हटाइयो।" });
});

app.post("/api/admin/personalities", requireAdmin, (req: Request, res: Response) => {
  const input = personalityFromBody(req.body, true);
  if (!input.slug || !SLUG_PATTERN.test(input.slug)) {
    res.status(400).json({ message: "मिल्दो चिह्न (slug) आवश्यक छ, जस्तै: gagan-thapa।" });
    return;
  }
  if (!input.name) {
    res.status(400).json({ message: "व्यक्तित्वको नाम आवश्यक छ।" });
    return;
  }
  if (personalities.some((p) => p.slug === input.slug)) {
    res.status(400).json({ message: "यो व्यक्तित्व पहिल्यै अवस्थित छ।" });
    return;
  }
  const created: Personality = {
    slug: input.slug,
    name: input.name,
    role: input.role,
    description: input.description,
  };
  personalities.push(created);
  res.status(201).json({ data: created, message: "व्यक्तित्व थपियो।" });
});

app.put("/api/admin/personalities/:slug", requireAdmin, (req: Request, res: Response) => {
  const target = personalities.find((p) => p.slug === req.params.slug);
  if (!target) {
    res.status(404).json({ message: "व्यक्तित्व फेला परेन।" });
    return;
  }
  const input = personalityFromBody(req.body, true);
  if ((req.body as Record<string, unknown>).name !== undefined && !input.name) {
    res.status(400).json({ message: "व्यक्तित्वको नाम आवश्यक छ।" });
    return;
  }
  if (input.name) target.name = input.name;
  target.role = input.role;
  target.description = input.description;
  res.json({ data: target, message: "व्यक्तित्व अद्यावधिक गरियो।" });
});

app.delete("/api/admin/personalities/:slug", requireAdmin, (req: Request, res: Response) => {
  const index = personalities.findIndex((p) => p.slug === req.params.slug);
  if (index === -1) {
    res.status(404).json({ message: "व्यक्तित्व फेला परेन।" });
    return;
  }
  if (newsFeed.some((n) => n.personalities.includes(req.params.slug))) {
    res.status(400).json({ message: "यो व्यक्तित्वको समाचारहरू छन्। पहिले ती हटाउनुहोस्।" });
    return;
  }
  const [removed] = personalities.splice(index, 1);
  res.json({ data: removed, message: "व्यक्तित्व हटाइयो।" });
});

app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ message: "अनुरोध गरिएको API मौजुद छैन।" });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err.message === "CORS not allowed for this origin") {
    res.status(403).json({ message: "अनुमति नभएको स्रोतबाट अनुरोध।" });
    return;
  }
  res.status(500).json({ message: "सर्भरमा समस्या भयो। पछि पुनः प्रयास गर्नुहोस्।" });
});

app.listen(PORT, () => {
  console.log(`न्युज API सर्भर चालू छ: http://localhost:${PORT}`);
  console.log(`अनुमति स्रोतहरू: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "सबै (विकास)"}`);
  console.log(`अगाडिको साइट (CORS): ${ORIGIN}`);
});