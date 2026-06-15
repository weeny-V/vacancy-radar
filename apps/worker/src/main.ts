import { PrismaClient, SourceName } from "@prisma/client";
import { Queue, Worker } from "bullmq";
import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import IORedis from "ioredis";
import { canonicalizeUrl, formatTelegramMessage, NormalizedVacancy, scoreVacancy } from "@vacancy-radar/shared";

const prisma = new PrismaClient();
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const queue = new Queue("vacancy-radar", { connection: connection as any });
const scheduleEnabled = process.env.SCHEDULED_FETCH_ENABLED !== "false";
const douFetchIntervalMs = Number(process.env.DOU_FETCH_INTERVAL_MINUTES ?? 30) * 60 * 1000;
const djinniFetchIntervalMs = Number(process.env.DJINNI_FETCH_INTERVAL_MINUTES ?? 30) * 60 * 1000;

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

function hashVacancy(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

async function fetchHtml(url: string) {
  const response = await fetch(url, {
    headers: { "user-agent": "VacancyRadarMVP/0.1 (+local development)" }
  });
  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} for ${url}`);
  }
  return response.text();
}

async function fetchDou(searchUrl: string): Promise<NormalizedVacancy[]> {
  const html = await fetchHtml(searchUrl);
  const $ = cheerio.load(html);
  const vacancies: NormalizedVacancy[] = [];
  const seen = new Set<string>();

  $("a[href*='/vacancies/']").each((_, link) => {
    const href = $(link).attr("href");
    const title = $(link).text().replace(/\s+/g, " ").trim();
    if (!href || !title || !/\/companies\/[^/]+\/vacancies\/\d+\/?/.test(href)) return;

    const sourceUrl = canonicalizeUrl(new URL(href, "https://jobs.dou.ua").toString());
    if (seen.has(sourceUrl)) return;
    seen.add(sourceUrl);

    const container = $(link).closest("li, article, div");
    const text = container.text().replace(/\s+/g, " ").trim() || title;
    const company = container.find("a[href*='/companies/']").not(link).first().text().replace(/\s+/g, " ").trim() || null;
    const location = container.find(".cities").first().text().replace(/\s+/g, " ").trim() || null;

    vacancies.push({
      source: "DOU",
      sourceUrl,
      title,
      company,
      location,
      remoteType: /remote|віддал/i.test(text) ? "remote" : null,
      description: text,
      skills: extractSkills(`${title} ${text}`),
      contentHash: hashVacancy(`${sourceUrl}|${title}|${text}`)
    });
  });

  return vacancies;
}

async function fetchDjinni(searchUrl: string): Promise<NormalizedVacancy[]> {
  const html = await fetchHtml(searchUrl);
  const $ = cheerio.load(html);
  const vacancies: NormalizedVacancy[] = [];
  const seen = new Set<string>();

  $("a[href^='/jobs/']").each((_, link) => {
    const href = $(link).attr("href");
    const title = $(link).text().replace(/\s+/g, " ").trim();
    if (!href || !title || !/^\/jobs\/\d+-.+\/?$/.test(href)) return;

    const sourceUrl = canonicalizeUrl(new URL(href, "https://djinni.co").toString());
    if (seen.has(sourceUrl)) return;
    seen.add(sourceUrl);

    const container = $(link).closest("li, article, div");
    const description = container.text().replace(/\s+/g, " ").trim() || title;
    const salary = description.match(/\$([0-9][0-9\s]*)/);
    const salaryValue = salary?.[1] ? Number(salary[1].replace(/\s/g, "")) : null;

    vacancies.push({
      source: "DJINNI",
      sourceUrl,
      title,
      company: null,
      location: /remote|віддал/i.test(description) ? "Remote" : null,
      remoteType: /remote|віддал/i.test(description) ? "remote" : null,
      salaryMin: salaryValue,
      salaryCurrency: salaryValue ? "USD" : null,
      description,
      skills: extractSkills(`${title} ${description}`),
      contentHash: hashVacancy(`${sourceUrl}|${title}|${description}`)
    });
  });

  return vacancies;
}

function extractSkills(text: string) {
  const known = ["React", "TypeScript", "JavaScript", "Node.js", "Next.js", "Angular", "Vue", "Python", "Java", "AWS"];
  const lower = text.toLowerCase();
  return known.filter((skill) => lower.includes(skill.toLowerCase()));
}

async function sendTelegram(chatId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { skipped: true, error: "TELEGRAM_BOT_TOKEN is not configured" };
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false })
  });
  if (!response.ok) {
    return { skipped: false, error: await response.text() };
  }
  return { skipped: false };
}

async function processSource(sourceName: SourceName) {
  const defaults = sourceDefaults[sourceName];
  const source = await prisma.source.upsert({
    where: { name: sourceName },
    update: {},
    create: {
      name: sourceName,
      baseUrl: defaults.baseUrl,
      searchUrl: defaults.searchUrl,
      queryLabel: defaults.queryLabel
    }
  });
  const run = await prisma.sourceFetchRun.create({ data: { sourceId: source.id, status: "running" } });

  try {
    if (!source.enabled) {
      throw new Error(`${sourceName} source is disabled`);
    }
    const searchUrl = source.searchUrl ?? defaults.searchUrl;
    const user = await prisma.user.findFirst({ include: { profile: true, notificationChannels: true } });
    const vacancies = sourceName === "DOU" ? await fetchDou(searchUrl) : await fetchDjinni(searchUrl);
    if (vacancies.length === 0) {
      throw new Error(`No vacancies parsed from ${searchUrl}`);
    }
    let importedCount = 0;
    let duplicateCount = 0;
    let matchedCount = 0;
    let notifiedCount = 0;
    let failedCount = 0;

    for (const vacancy of vacancies) {
      const existing = await prisma.vacancy.findUnique({ where: { sourceUrl: vacancy.sourceUrl } });
      if (existing) {
        duplicateCount += 1;
        continue;
      }

      const created = await prisma.vacancy.create({
        data: {
          sourceId: source.id,
          sourceUrl: vacancy.sourceUrl,
          title: vacancy.title,
          company: vacancy.company,
          location: vacancy.location,
          remoteType: vacancy.remoteType,
          salaryMin: vacancy.salaryMin,
          salaryMax: vacancy.salaryMax,
          salaryCurrency: vacancy.salaryCurrency,
          description: vacancy.description,
          skills: vacancy.skills,
          publishedAt: vacancy.publishedAt,
          contentHash: vacancy.contentHash
        }
      });
      importedCount += 1;

      if (!user?.profile) continue;
      const match = scoreVacancy(user.profile, vacancy);
      await prisma.vacancyMatch.create({
        data: { vacancyId: created.id, userId: user.id, score: match.score, reasons: match.reasons, blocked: match.blocked }
      });
      matchedCount += 1;

      const shouldNotify = !match.blocked && match.score >= user.profile.matchThreshold;
      const telegram = user.notificationChannels.find((channel) => channel.type === "telegram" && channel.enabled);
      if (!shouldNotify || !telegram) continue;

      const existingNotification = await prisma.notification.findUnique({
        where: { userId_vacancyId_channel: { userId: user.id, vacancyId: created.id, channel: "telegram" } }
      });
      if (existingNotification) continue;

      const message = formatTelegramMessage(vacancy, match);
      const result = await sendTelegram(telegram.target, message);
      await prisma.notification.create({
        data: {
          userId: user.id,
          vacancyId: created.id,
          channel: "telegram",
          status: result.error ? (result.skipped ? "SKIPPED" : "FAILED") : "SENT",
          error: result.error,
          sentAt: result.error ? null : new Date()
        }
      });
      if (result.error) failedCount += 1;
      else notifiedCount += 1;
    }

    await prisma.sourceFetchRun.update({
      where: { id: run.id },
      data: { status: "success", importedCount, duplicateCount, matchedCount, notifiedCount, failedCount, finishedAt: new Date() }
    });
    console.log(
      `${sourceName} fetch success: imported=${importedCount} duplicates=${duplicateCount} matched=${matchedCount} notified=${notifiedCount} failed=${failedCount}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.sourceFetchRun.update({
      where: { id: run.id },
      data: { status: "failed", failedCount: 1, error: message, finishedAt: new Date() }
    });
    console.error(`${sourceName} fetch failed: ${message}`);
  }
}

function assertPositiveInterval(name: string, intervalMs: number) {
  if (!Number.isFinite(intervalMs) || intervalMs < 60_000) {
    throw new Error(`${name} must be at least 1 minute`);
  }
}

async function upsertFetchSchedule(source: SourceName, intervalMs: number) {
  const jobName = source === SourceName.DOU ? "fetch-source:dou" : "fetch-source:djinni";
  await queue.upsertJobScheduler(
    `scheduled-fetch:${source.toLowerCase()}`,
    { every: intervalMs },
    {
      name: jobName,
      data: { source, scheduled: true },
      opts: {
        attempts: 2,
        backoff: { type: "fixed", delay: 60_000 },
        removeOnComplete: 20,
        removeOnFail: 50
      }
    }
  );
  console.log(`${source} scheduled fetch enabled every ${Math.round(intervalMs / 60_000)} minutes`);
}

async function configureScheduledFetches() {
  if (!scheduleEnabled) {
    await Promise.all([
      queue.removeJobScheduler("scheduled-fetch:dou"),
      queue.removeJobScheduler("scheduled-fetch:djinni")
    ]);
    console.log("Scheduled fetches disabled");
    return;
  }

  assertPositiveInterval("DOU_FETCH_INTERVAL_MINUTES", douFetchIntervalMs);
  assertPositiveInterval("DJINNI_FETCH_INTERVAL_MINUTES", djinniFetchIntervalMs);
  await Promise.all([
    upsertFetchSchedule(SourceName.DOU, douFetchIntervalMs),
    upsertFetchSchedule(SourceName.DJINNI, djinniFetchIntervalMs)
  ]);
}

const worker = new Worker("vacancy-radar", async (job) => {
  if (job.name === "fetch-source:dou") return processSource("DOU");
  if (job.name === "fetch-source:djinni") return processSource("DJINNI");
}, { connection: connection as any });

worker.on("failed", (job, error) => {
  console.error(`${job?.name ?? "unknown"} job failed: ${error.message}`);
});

configureScheduledFetches()
  .then(() => console.log("Vacancy Radar worker started"))
  .catch((error) => {
    console.error(`Worker startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
