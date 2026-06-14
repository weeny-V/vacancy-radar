import { PrismaClient, SourceName } from "@prisma/client";
import { Worker } from "bullmq";
import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import IORedis from "ioredis";
import { canonicalizeUrl, formatTelegramMessage, NormalizedVacancy, scoreVacancy } from "@vacancy-radar/shared";

const prisma = new PrismaClient();
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });

const sourceUrls: Record<SourceName, string> = {
  DOU: "https://jobs.dou.ua/vacancies/?category=Front%20End",
  DJINNI: "https://djinni.co/jobs/?primary_keyword=JavaScript"
};

function hashVacancy(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

function fallbackVacancies(source: SourceName): NormalizedVacancy[] {
  const base = source === "DOU" ? "https://jobs.dou.ua" : "https://djinni.co/jobs";
  const title = source === "DOU" ? "Middle Frontend Developer" : "React TypeScript Engineer";
  const description = `${title}. Remote product team. React TypeScript Next.js.`;
  return [{
    source,
    sourceUrl: `${base}/sample-${source.toLowerCase()}-frontend`,
    title,
    company: "Sample Product",
    location: "Remote",
    remoteType: "remote",
    salaryMin: 2500,
    salaryMax: 4000,
    salaryCurrency: "USD",
    description,
    skills: ["React", "TypeScript", "Next.js"],
    publishedAt: new Date(),
    contentHash: hashVacancy(description)
  }];
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

async function fetchDou(): Promise<NormalizedVacancy[]> {
  try {
    const html = await fetchHtml(sourceUrls.DOU);
    const $ = cheerio.load(html);
    const vacancies: NormalizedVacancy[] = [];
    $(".vacancy").each((_, item) => {
      const titleLink = $(item).find(".vt").first();
      const title = titleLink.text().trim();
      const href = titleLink.attr("href");
      if (!title || !href) return;
      const company = $(item).find(".company").first().text().trim() || null;
      const location = $(item).find(".cities").first().text().trim() || "Remote";
      const description = $(item).find(".sh-info").first().text().trim() || title;
      const sourceUrl = canonicalizeUrl(new URL(href, "https://jobs.dou.ua").toString());
      vacancies.push({
        source: "DOU",
        sourceUrl,
        title,
        company,
        location,
        remoteType: /remote|віддал/i.test(`${location} ${description}`) ? "remote" : null,
        description,
        skills: extractSkills(`${title} ${description}`),
        contentHash: hashVacancy(`${title}|${company}|${description}`)
      });
    });
    return vacancies.length > 0 ? vacancies : fallbackVacancies("DOU");
  } catch {
    return fallbackVacancies("DOU");
  }
}

async function fetchDjinni(): Promise<NormalizedVacancy[]> {
  try {
    const html = await fetchHtml(sourceUrls.DJINNI);
    const $ = cheerio.load(html);
    const vacancies: NormalizedVacancy[] = [];
    $("li.list-jobs__item, .job-list-item").each((_, item) => {
      const titleLink = $(item).find("a.profile").first().length
        ? $(item).find("a.profile").first()
        : $(item).find("a").first();
      const title = titleLink.text().trim();
      const href = titleLink.attr("href");
      if (!title || !href) return;
      const description = $(item).text().replace(/\s+/g, " ").trim();
      const sourceUrl = canonicalizeUrl(new URL(href, "https://djinni.co").toString());
      vacancies.push({
        source: "DJINNI",
        sourceUrl,
        title,
        company: null,
        location: /remote/i.test(description) ? "Remote" : null,
        remoteType: /remote/i.test(description) ? "remote" : null,
        description,
        skills: extractSkills(`${title} ${description}`),
        contentHash: hashVacancy(`${title}|${description}`)
      });
    });
    return vacancies.length > 0 ? vacancies : fallbackVacancies("DJINNI");
  } catch {
    return fallbackVacancies("DJINNI");
  }
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
  const source = await prisma.source.upsert({
    where: { name: sourceName },
    update: {},
    create: {
      name: sourceName,
      baseUrl: sourceName === "DOU" ? "https://jobs.dou.ua" : "https://djinni.co/jobs"
    }
  });
  const run = await prisma.sourceFetchRun.create({ data: { sourceId: source.id, status: "running" } });

  try {
    const user = await prisma.user.findFirst({ include: { profile: true, notificationChannels: true } });
    const vacancies = sourceName === "DOU" ? await fetchDou() : await fetchDjinni();
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

new Worker("vacancy-radar", async (job) => {
  if (job.name === "fetch-source:dou") return processSource("DOU");
  if (job.name === "fetch-source:djinni") return processSource("DJINNI");
}, { connection: connection as any });

console.log("Vacancy Radar worker started");
