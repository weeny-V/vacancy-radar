import "reflect-metadata";
import { Body, Controller, Get, Module, Param, Post, Query } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PrismaClient, SourceName } from "@prisma/client";
import { Queue } from "bullmq";
import IORedis from "ioredis";

const prisma = new PrismaClient();
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const queue = new Queue("vacancy-radar", { connection: connection as any });
const appUserEmail = process.env.APP_USER_EMAIL ?? "local@vacancy-radar.dev";
const appUserName = process.env.APP_USER_NAME ?? "Local Job Seeker";
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
  return prisma.user.upsert({
    where: { email: appUserEmail },
    update: {},
    create: { email: appUserEmail, name: appUserName }
  });
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

  @Get("profiles/me")
  async getProfile() {
    const user = await getLocalUser();
    return prisma.jobProfile.findUnique({ where: { userId: user.id } });
  }

  @Get("sources")
  async sources() {
    await ensureSources();
    return prisma.source.findMany({ orderBy: { name: "asc" } });
  }

  @Post("sources/:name")
  async updateSource(@Param("name") name: SourceName, @Body() body: any) {
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
  async upsertProfile(@Body() body: any) {
    const user = await getLocalUser();
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
  async vacancies(@Query("status") status?: "NEW" | "SAVED" | "IGNORED") {
    const user = await getLocalUser();
    return prisma.vacancy.findMany({
      where: status ? { status } : {},
      orderBy: { firstSeenAt: "desc" },
      include: { source: true, matches: { where: { userId: user.id } } },
      take: 100
    });
  }

  @Get("vacancies/:id")
  async vacancy(@Param("id") id: string) {
    return prisma.vacancy.findUnique({ where: { id }, include: { source: true, matches: true } });
  }

  @Post("vacancies/:id/save")
  async saveVacancy(@Param("id") id: string) {
    return prisma.vacancy.update({ where: { id }, data: { status: "SAVED" } });
  }

  @Post("vacancies/:id/ignore")
  async ignoreVacancy(@Param("id") id: string) {
    return prisma.vacancy.update({ where: { id }, data: { status: "IGNORED" } });
  }

  @Post("notifications/telegram/connect")
  async connectTelegram(@Body() body: { chatId: string }) {
    const user = await getLocalUser();
    return prisma.notificationChannel.upsert({
      where: { id: body.chatId },
      update: { target: body.chatId, enabled: true },
      create: { id: body.chatId, userId: user.id, type: "telegram", target: body.chatId }
    });
  }

  @Post("admin/fetch-runs/run")
  async runFetch() {
    await queue.add("fetch-source:dou", { source: SourceName.DOU });
    await queue.add("fetch-source:djinni", { source: SourceName.DJINNI });
    return { queued: ["fetch-source:dou", "fetch-source:djinni"] };
  }

  @Get("admin/fetch-runs")
  async fetchRuns() {
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
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.listen(Number(process.env.API_PORT ?? 4000));
}

bootstrap();
