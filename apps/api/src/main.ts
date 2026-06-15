import "reflect-metadata";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Module,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PrismaClient, SourceName } from "@prisma/client";
import { Queue } from "bullmq";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import IORedis from "ioredis";

const prisma = new PrismaClient();
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const queue = new Queue("vacancy-radar", { connection: connection as any });
const appUserEmail = process.env.APP_USER_EMAIL ?? "local@vacancy-radar.dev";
const appUserName = process.env.APP_USER_NAME ?? "Local Job Seeker";
const appUserPassword = process.env.APP_USER_PASSWORD ?? "vacancy-radar-local";
const authSecret = process.env.AUTH_SECRET ?? "vacancy-radar-dev-secret";
const sessionCookieName = "vacancy_radar_session";
const csrfCookieName = "vacancy_radar_csrf";
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const loginRateLimitMax = Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 5);
const loginRateLimitWindowMs = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_SECONDS ?? 15 * 60) * 1000;
const adminFetchRateLimitMax = Number(process.env.ADMIN_FETCH_RATE_LIMIT_MAX ?? 6);
const adminFetchRateLimitWindowMs = Number(process.env.ADMIN_FETCH_RATE_LIMIT_WINDOW_SECONDS ?? 60 * 60) * 1000;
const sourceDefaults: Record<SourceName, { baseUrl: string; searchUrl: string; queryLabel: string }> = {
  DOU: {
    baseUrl: "https://jobs.dou.ua",
    searchUrl: "https://jobs.dou.ua/vacancies/?category=Front%20End",
    queryLabel: "Front End"
  },
  DJINNI: {
    baseUrl: "https://djinni.co/jobs",
    searchUrl: "https://djinni.co/jobs/?primary_keyword=JavaScript",
    queryLabel: "JavaScript"
  }
};

async function getLocalUser() {
  const existingUser = await prisma.user.findUnique({ where: { email: appUserEmail } });
  const passwordHash = existingUser?.passwordHash && verifyPassword(appUserPassword, existingUser.passwordHash)
    ? existingUser.passwordHash
    : hashPassword(appUserPassword);

  return prisma.user.upsert({
    where: { email: appUserEmail },
    update: { name: appUserName, passwordHash },
    create: { email: appUserEmail, name: appUserName, passwordHash }
  });
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, storedHash: string) {
  const [, salt, expected] = storedHash.split("$");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return expectedBuffer.length === actual.length && timingSafeEqual(expectedBuffer, actual);
}

function signSession(userId: string, expiresAt: number) {
  return createHmac("sha256", authSecret).update(`${userId}.${expiresAt}`).digest("hex");
}

function createSessionToken(userId: string) {
  const expiresAt = Date.now() + sessionTtlMs;
  return `${userId}.${expiresAt}.${signSession(userId, expiresAt)}`;
}

function signCsrfToken(nonce: string) {
  return createHmac("sha256", authSecret).update(nonce).digest("hex");
}

function createCsrfToken() {
  const nonce = randomBytes(32).toString("hex");
  return `${nonce}.${signCsrfToken(nonce)}`;
}

function hashRateLimitPart(value: string) {
  return createHmac("sha256", authSecret).update(value).digest("hex").slice(0, 24);
}

function verifyCsrfToken(token?: string) {
  const [nonce, signature] = String(token ?? "").split(".");
  if (!nonce || !signature) return false;
  const expected = signCsrfToken(nonce);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function parseCookies(header?: string) {
  return Object.fromEntries((header ?? "").split(";").map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }).filter(([key]) => key));
}

function getHeaderValue(req: Request, name: string) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getClientIp(req: Request) {
  const forwardedFor = getHeaderValue(req, "x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || req.ip || req.socket.remoteAddress || "unknown";
}

async function consumeRateLimit(options: { key: string; limit: number; windowMs: number; label: string }) {
  const count = await connection.incr(options.key);
  if (count === 1) {
    await connection.pexpire(options.key, options.windowMs);
  }
  if (count <= options.limit) return;

  const ttlMs = await connection.pttl(options.key);
  const retryAfterSeconds = Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : options.windowMs) / 1000));
  throw new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message: `${options.label} rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`,
      retryAfterSeconds
    },
    HttpStatus.TOO_MANY_REQUESTS
  );
}

async function consumeLoginRateLimit(req: Request, email: string) {
  const ipPart = hashRateLimitPart(getClientIp(req));
  const emailPart = hashRateLimitPart(email.toLowerCase());
  await consumeRateLimit({
    key: `rate-limit:login:${ipPart}:${emailPart}`,
    limit: loginRateLimitMax,
    windowMs: loginRateLimitWindowMs,
    label: "Login"
  });
}

async function consumeAdminFetchRateLimit(userId: string) {
  await consumeRateLimit({
    key: `rate-limit:admin-fetch:${hashRateLimitPart(userId)}`,
    limit: adminFetchRateLimitMax,
    windowMs: adminFetchRateLimitWindowMs,
    label: "Manual fetch"
  });
}

function requireCsrf(req: Request) {
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[csrfCookieName];
  const headerToken = getHeaderValue(req, "x-csrf-token");
  if (!cookieToken || !headerToken || cookieToken !== headerToken || !verifyCsrfToken(cookieToken)) {
    throw new ForbiddenException("Invalid CSRF token");
  }
}

async function requireUser(req: Request) {
  const token = parseCookies(req.headers.cookie)[sessionCookieName];
  if (!token) throw new UnauthorizedException("Login required");
  const [userId, expiresRaw, signature] = token.split(".");
  const expiresAt = Number(expiresRaw);
  if (!userId || !expiresAt || !signature || expiresAt < Date.now()) {
    throw new UnauthorizedException("Session expired");
  }
  if (signature !== signSession(userId, expiresAt)) {
    throw new UnauthorizedException("Invalid session");
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new UnauthorizedException("User not found");
  return user;
}

function setSessionCookie(res: Response, token: string) {
  const secure = process.env.NODE_ENV === "production";
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: sessionTtlMs,
    path: "/"
  });
}

function setCsrfCookie(res: Response) {
  const secure = process.env.NODE_ENV === "production";
  const token = createCsrfToken();
  res.cookie(csrfCookieName, token, {
    httpOnly: false,
    sameSite: "lax",
    secure,
    maxAge: sessionTtlMs,
    path: "/"
  });
  return token;
}

function clearAuthCookies(res: Response) {
  res.clearCookie(sessionCookieName, { path: "/" });
  res.clearCookie(csrfCookieName, { path: "/" });
}

function assertRuntimeConfig() {
  if (process.env.NODE_ENV !== "production") return;
  if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET === "change-this-before-deploying") {
    throw new Error("AUTH_SECRET must be set to a strong unique value in production");
  }
  if (!process.env.APP_USER_PASSWORD || process.env.APP_USER_PASSWORD === "vacancy-radar-local") {
    throw new Error("APP_USER_PASSWORD must be set to a strong unique value in production");
  }
}

function assertObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string, options: { required?: boolean; max?: number } = {}) {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    if (options.required) throw new BadRequestException(`${key} is required`);
    return null;
  }
  if (typeof value !== "string") throw new BadRequestException(`${key} must be a string`);
  const trimmed = value.trim();
  if (options.required && !trimmed) throw new BadRequestException(`${key} is required`);
  if (options.max && trimmed.length > options.max) throw new BadRequestException(`${key} is too long`);
  return trimmed;
}

function booleanField(body: Record<string, unknown>, key: string, fallback: boolean) {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new BadRequestException(`${key} must be a boolean`);
  return value;
}

function numberField(body: Record<string, unknown>, key: string, options: { fallback?: number | null; min?: number; max?: number } = {}) {
  const value = body[key];
  if (value === undefined || value === null || value === "") return options.fallback ?? null;
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) throw new BadRequestException(`${key} must be a number`);
  const integer = Math.trunc(numberValue);
  if (options.min !== undefined && integer < options.min) throw new BadRequestException(`${key} is too low`);
  if (options.max !== undefined && integer > options.max) throw new BadRequestException(`${key} is too high`);
  return integer;
}

function stringArrayField(body: Record<string, unknown>, key: string, maxItems = 50) {
  const value = body[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestException(`${key} must be an array`);
  if (value.length > maxItems) throw new BadRequestException(`${key} has too many items`);
  return value.map((item) => {
    if (typeof item !== "string") throw new BadRequestException(`${key} must contain only strings`);
    return item.trim();
  }).filter(Boolean).slice(0, maxItems);
}

function urlField(body: Record<string, unknown>, key: string, fallback: string) {
  const value = stringField(body, key, { max: 500 }) ?? fallback;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported protocol");
    return url.toString();
  } catch {
    throw new BadRequestException(`${key} must be a valid HTTP URL`);
  }
}

function validateSourceName(value: string) {
  const normalizedName = value.toUpperCase();
  if (normalizedName !== SourceName.DOU && normalizedName !== SourceName.DJINNI) {
    throw new BadRequestException("Unsupported source");
  }
  return normalizedName as SourceName;
}

function profileInput(bodyValue: unknown) {
  const body = assertObject(bodyValue);
  return {
    role: stringField(body, "role", { required: true, max: 100 })!,
    seniority: stringField(body, "seniority", { required: true, max: 80 })!,
    skills: stringArrayField(body, "skills"),
    location: stringField(body, "location", { max: 120 }),
    remoteOnly: booleanField(body, "remoteOnly", true),
    salaryMin: numberField(body, "salaryMin", { fallback: null, min: 0, max: 1_000_000 }),
    salaryCurrency: stringField(body, "salaryCurrency", { max: 12 }) ?? "USD",
    includeKeywords: stringArrayField(body, "includeKeywords"),
    excludeKeywords: stringArrayField(body, "excludeKeywords"),
    matchThreshold: numberField(body, "matchThreshold", { fallback: 60, min: 0, max: 100 }) ?? 60
  };
}

function sourceInput(bodyValue: unknown, defaults: { baseUrl: string; searchUrl: string; queryLabel: string }) {
  const body = assertObject(bodyValue);
  return {
    baseUrl: urlField(body, "baseUrl", defaults.baseUrl),
    searchUrl: urlField(body, "searchUrl", defaults.searchUrl),
    queryLabel: stringField(body, "queryLabel", { max: 120 }),
    enabled: booleanField(body, "enabled", true)
  };
}

function telegramInput(bodyValue: unknown) {
  const body = assertObject(bodyValue);
  const chatId = stringField(body, "chatId", { required: true, max: 80 })!;
  if (!/^-?\d{4,32}$/.test(chatId)) throw new BadRequestException("chatId must be a Telegram numeric chat ID");
  return { chatId };
}

type TelegramChatCandidate = {
  chatId: string;
  title: string;
  username?: string | null;
  lastMessageAt?: string | null;
};

function telegramToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new BadRequestException("TELEGRAM_BOT_TOKEN is not configured");
  return token;
}

function telegramChatTitle(chat: Record<string, unknown>) {
  const title = typeof chat.title === "string" ? chat.title : null;
  const firstName = typeof chat.first_name === "string" ? chat.first_name : null;
  const lastName = typeof chat.last_name === "string" ? chat.last_name : null;
  const username = typeof chat.username === "string" ? `@${chat.username}` : null;
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  return title ?? (fullName || username || "Telegram chat");
}

function telegramMessageFromUpdate(update: Record<string, unknown>) {
  for (const key of ["message", "edited_message", "channel_post", "edited_channel_post"]) {
    const message = update[key];
    if (message && typeof message === "object" && !Array.isArray(message)) {
      return message as Record<string, unknown>;
    }
  }
  return null;
}

async function fetchTelegramChatCandidates(): Promise<TelegramChatCandidate[]> {
  const response = await fetch(`https://api.telegram.org/bot${telegramToken()}/getUpdates`, {
    headers: { "content-type": "application/json" }
  });
  const payload = await response.json().catch(() => null) as {
    ok?: boolean;
    description?: string;
    result?: Array<Record<string, unknown>>;
  } | null;

  if (!response.ok || !payload?.ok) {
    throw new BadRequestException(payload?.description ?? "Telegram getUpdates failed");
  }

  const byChatId = new Map<string, TelegramChatCandidate>();
  for (const update of payload.result ?? []) {
    const message = telegramMessageFromUpdate(update);
    const chat = message?.chat;
    if (!chat || typeof chat !== "object" || Array.isArray(chat)) continue;
    const chatRecord = chat as Record<string, unknown>;
    const id = chatRecord.id;
    if (typeof id !== "number" && typeof id !== "string") continue;

    const chatId = String(id);
    const date = typeof message?.date === "number" ? new Date(message.date * 1000).toISOString() : null;
    byChatId.set(chatId, {
      chatId,
      title: telegramChatTitle(chatRecord),
      username: typeof chatRecord.username === "string" ? chatRecord.username : null,
      lastMessageAt: date
    });
  }

  return Array.from(byChatId.values()).sort((left, right) =>
    String(right.lastMessageAt ?? "").localeCompare(String(left.lastMessageAt ?? ""))
  );
}

async function upsertTelegramChannel(userId: string, chatId: string) {
  return prisma.notificationChannel.upsert({
    where: { id: chatId },
    update: { target: chatId, enabled: true },
    create: { id: chatId, userId, type: "telegram", target: chatId }
  });
}

function loginInput(bodyValue: unknown) {
  const body = assertObject(bodyValue);
  return {
    email: stringField(body, "email", { required: true, max: 254 })!,
    password: stringField(body, "password", { required: true, max: 256 })!
  };
}

async function ensureSources() {
  await Promise.all((Object.keys(sourceDefaults) as SourceName[]).map(async (name) => {
    const defaults = sourceDefaults[name];
    const existing = await prisma.source.findUnique({ where: { name } });
    return prisma.source.upsert({
      where: { name },
      update: {
        baseUrl: existing?.baseUrl ?? defaults.baseUrl,
        searchUrl: existing?.searchUrl ?? defaults.searchUrl,
        queryLabel: existing?.queryLabel ?? defaults.queryLabel
      },
      create: {
        name,
        baseUrl: defaults.baseUrl,
        searchUrl: defaults.searchUrl,
        queryLabel: defaults.queryLabel
      }
    });
  }));
}

@Controller()
class AppController {
  @Get("health")
  health() {
    return { ok: true, service: "vacancy-radar-api" };
  }

  @Post("auth/login")
  async login(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = loginInput(body);
    await consumeLoginRateLimit(req, input.email);
    const user = await getLocalUser();
    if (input.email !== user.email || !user.passwordHash || !verifyPassword(input.password, user.passwordHash)) {
      throw new UnauthorizedException("Invalid email or password");
    }
    setSessionCookie(res, createSessionToken(user.id));
    const csrfToken = setCsrfCookie(res);
    return { csrfToken, user: { email: user.email, name: user.name } };
  }

  @Get("auth/csrf")
  csrf(@Res({ passthrough: true }) res: Response) {
    return { csrfToken: setCsrfCookie(res) };
  }

  @Post("auth/logout")
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await requireUser(req);
    requireCsrf(req);
    clearAuthCookies(res);
    return { ok: true };
  }

  @Get("auth/session")
  async session(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const user = await requireUser(req);
    return { csrfToken: setCsrfCookie(res), user: { email: user.email, name: user.name } };
  }

  @Get("profiles/me")
  async getProfile(@Req() req: Request) {
    const user = await requireUser(req);
    return prisma.jobProfile.findUnique({ where: { userId: user.id } });
  }

  @Get("sources")
  async sources(@Req() req: Request) {
    await requireUser(req);
    await ensureSources();
    return prisma.source.findMany({ orderBy: { name: "asc" } });
  }

  @Post("sources/:name")
  async updateSource(@Req() req: Request, @Param("name") name: string, @Body() body: unknown) {
    await requireUser(req);
    requireCsrf(req);
    const normalizedName = validateSourceName(name);
    const defaults = sourceDefaults[normalizedName];
    const input = sourceInput(body, defaults);

    return prisma.source.upsert({
      where: { name: normalizedName },
      update: {
        baseUrl: input.baseUrl,
        searchUrl: input.searchUrl,
        queryLabel: input.queryLabel,
        enabled: input.enabled
      },
      create: {
        name: normalizedName,
        baseUrl: input.baseUrl,
        searchUrl: input.searchUrl,
        queryLabel: input.queryLabel ?? defaults.queryLabel,
        enabled: input.enabled
      }
    });
  }

  @Post("profiles")
  async upsertProfile(@Req() req: Request, @Body() body: unknown) {
    const user = await requireUser(req);
    requireCsrf(req);
    const input = profileInput(body);
    return prisma.jobProfile.upsert({
      where: { userId: user.id },
      update: {
        role: input.role,
        seniority: input.seniority,
        skills: input.skills,
        location: input.location,
        remoteOnly: input.remoteOnly,
        salaryMin: input.salaryMin,
        salaryCurrency: input.salaryCurrency,
        includeKeywords: input.includeKeywords,
        excludeKeywords: input.excludeKeywords,
        matchThreshold: input.matchThreshold
      },
      create: {
        userId: user.id,
        role: input.role,
        seniority: input.seniority,
        skills: input.skills,
        location: input.location,
        remoteOnly: input.remoteOnly,
        salaryMin: input.salaryMin,
        salaryCurrency: input.salaryCurrency,
        includeKeywords: input.includeKeywords,
        excludeKeywords: input.excludeKeywords,
        matchThreshold: input.matchThreshold
      }
    });
  }

  @Get("vacancies")
  async vacancies(@Req() req: Request, @Query("status") status?: "NEW" | "SAVED" | "IGNORED") {
    const user = await requireUser(req);
    return prisma.vacancy.findMany({
      where: status ? { status } : {},
      orderBy: { firstSeenAt: "desc" },
      include: { source: true, matches: { where: { userId: user.id } } },
      take: 100
    });
  }

  @Get("vacancies/:id")
  async vacancy(@Req() req: Request, @Param("id") id: string) {
    await requireUser(req);
    return prisma.vacancy.findUnique({ where: { id }, include: { source: true, matches: true } });
  }

  @Post("vacancies/:id/save")
  async saveVacancy(@Req() req: Request, @Param("id") id: string) {
    await requireUser(req);
    requireCsrf(req);
    return prisma.vacancy.update({ where: { id }, data: { status: "SAVED" } });
  }

  @Post("vacancies/:id/ignore")
  async ignoreVacancy(@Req() req: Request, @Param("id") id: string) {
    await requireUser(req);
    requireCsrf(req);
    return prisma.vacancy.update({ where: { id }, data: { status: "IGNORED" } });
  }

  @Post("notifications/telegram/connect")
  async connectTelegram(@Req() req: Request, @Body() body: unknown) {
    const user = await requireUser(req);
    requireCsrf(req);
    const input = telegramInput(body);
    return upsertTelegramChannel(user.id, input.chatId);
  }

  @Get("notifications/telegram/chats")
  async telegramChats(@Req() req: Request) {
    await requireUser(req);
    return { chats: await fetchTelegramChatCandidates() };
  }

  @Post("notifications/telegram/connect-latest")
  async connectLatestTelegram(@Req() req: Request) {
    const user = await requireUser(req);
    requireCsrf(req);
    const [latestChat] = await fetchTelegramChatCandidates();
    if (!latestChat) {
      throw new BadRequestException("No recent Telegram chats found. Send /start to the bot, then try again.");
    }
    const channel = await upsertTelegramChannel(user.id, latestChat.chatId);
    return { channel, chat: latestChat };
  }

  @Post("admin/fetch-runs/run")
  async runFetch(@Req() req: Request) {
    const user = await requireUser(req);
    requireCsrf(req);
    await consumeAdminFetchRateLimit(user.id);
    await queue.add("fetch-source:dou", { source: SourceName.DOU });
    await queue.add("fetch-source:djinni", { source: SourceName.DJINNI });
    return { queued: ["fetch-source:dou", "fetch-source:djinni"] };
  }

  @Get("admin/fetch-runs")
  async fetchRuns(@Req() req: Request) {
    await requireUser(req);
    return prisma.sourceFetchRun.findMany({
      orderBy: { startedAt: "desc" },
      include: { source: true },
      take: 25
    });
  }
}

@Module({ controllers: [AppController] })
class AppModule {}

async function bootstrap() {
  assertRuntimeConfig();
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "x-csrf-token"]
  });
  await app.listen(Number(process.env.API_PORT ?? 4000));
}

bootstrap();
