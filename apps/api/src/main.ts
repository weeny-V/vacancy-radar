import "reflect-metadata";
import { Body, Controller, Get, Module, Param, Post, Query } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PrismaClient, SourceName } from "@prisma/client";
import { Queue } from "bullmq";
import IORedis from "ioredis";

const prisma = new PrismaClient();
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const queue = new Queue("vacancy-radar", { connection: connection as any });

async function getLocalUser() {
  return prisma.user.upsert({
    where: { email: "local@vacancy-radar.dev" },
    update: {},
    create: { email: "local@vacancy-radar.dev", name: "Local Job Seeker" }
  });
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
