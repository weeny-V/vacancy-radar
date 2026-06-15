import "reflect-metadata";
import { Body, Controller, Get, Module, Param, Post, Query, Req, Res, UnauthorizedException } from "@nestjs/common";
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
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
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

function parseCookies(header?: string) {
  return Object.fromEntries((header ?? "").split(";").map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }).filter(([key]) => key));
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

function assertRuntimeConfig() {
  if (process.env.NODE_ENV !== "production") return;
  if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET === "change-this-before-deploying") {
    throw new Error("AUTH_SECRET must be set to a strong unique value in production");
  }
  if (!process.env.APP_USER_PASSWORD || process.env.APP_USER_PASSWORD === "vacancy-radar-local") {
    throw new Error("APP_USER_PASSWORD must be set to a strong unique value in production");
  }
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
  async login(@Body() body: { email?: string; password?: string }, @Res({ passthrough: true }) res: Response) {
    const user = await getLocalUser();
    if (body.email !== user.email || !user.passwordHash || !body.password || !verifyPassword(body.password, user.passwordHash)) {
      throw new UnauthorizedException("Invalid email or password");
    }
    setSessionCookie(res, createSessionToken(user.id));
    return { user: { email: user.email, name: user.name } };
  }

  @Post("auth/logout")
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(sessionCookieName, { path: "/" });
    return { ok: true };
  }

  @Get("auth/session")
  async session(@Req() req: Request) {
    const user = await requireUser(req);
    return { user: { email: user.email, name: user.name } };
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
  async updateSource(@Req() req: Request, @Param("name") name: SourceName, @Body() body: any) {
    await requireUser(req);
    const normalizedName = String(name).toUpperCase() as SourceName;
    const defaults = sourceDefaults[normalizedName];

    return prisma.source.upsert({
      where: { name: normalizedName },
      update: {
        baseUrl: String(body.baseUrl ?? defaults.baseUrl),
        searchUrl: String(body.searchUrl ?? defaults.searchUrl),
        queryLabel: body.queryLabel ? String(body.queryLabel) : null,
        enabled: Boolean(body.enabled)
      },
      create: {
        name: normalizedName,
        baseUrl: String(body.baseUrl ?? defaults.baseUrl),
        searchUrl: String(body.searchUrl ?? defaults.searchUrl),
        queryLabel: body.queryLabel ? String(body.queryLabel) : defaults.queryLabel,
        enabled: body.enabled === undefined ? true : Boolean(body.enabled)
      }
    });
  }

  @Post("profiles")
  async upsertProfile(@Req() req: Request, @Body() body: any) {
    const user = await requireUser(req);
    return prisma.jobProfile.upsert({
      where: { userId: user.id },
      update: {
        role: body.role,
        seniority: body.seniority,
        skills: body.skills ?? [],
        location: body.location,
        remoteOnly: Boolean(body.remoteOnly),
        salaryMin: body.salaryMin ? Number(body.salaryMin) : null,
        salaryCurrency: body.salaryCurrency ?? "USD",
        includeKeywords: body.includeKeywords ?? [],
        excludeKeywords: body.excludeKeywords ?? [],
        matchThreshold: Number(body.matchThreshold ?? 60)
      },
      create: {
        userId: user.id,
        role: body.role,
        seniority: body.seniority,
        skills: body.skills ?? [],
        location: body.location,
        remoteOnly: Boolean(body.remoteOnly),
        salaryMin: body.salaryMin ? Number(body.salaryMin) : null,
        salaryCurrency: body.salaryCurrency ?? "USD",
        includeKeywords: body.includeKeywords ?? [],
        excludeKeywords: body.excludeKeywords ?? [],
        matchThreshold: Number(body.matchThreshold ?? 60)
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
    return prisma.vacancy.update({ where: { id }, data: { status: "SAVED" } });
  }

  @Post("vacancies/:id/ignore")
  async ignoreVacancy(@Req() req: Request, @Param("id") id: string) {
    await requireUser(req);
    return prisma.vacancy.update({ where: { id }, data: { status: "IGNORED" } });
  }

  @Post("notifications/telegram/connect")
  async connectTelegram(@Req() req: Request, @Body() body: { chatId: string }) {
    const user = await requireUser(req);
    return prisma.notificationChannel.upsert({
      where: { id: body.chatId },
      update: { target: body.chatId, enabled: true },
      create: { id: body.chatId, userId: user.id, type: "telegram", target: body.chatId }
    });
  }

  @Post("admin/fetch-runs/run")
  async runFetch(@Req() req: Request) {
    await requireUser(req);
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
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:3000", credentials: true });
  await app.listen(Number(process.env.API_PORT ?? 4000));
}

bootstrap();
