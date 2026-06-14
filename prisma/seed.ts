import { PrismaClient, SourceName } from "@prisma/client";
import { createHash } from "node:crypto";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: "local@vacancy-radar.dev" },
    update: {},
    create: { email: "local@vacancy-radar.dev", name: "Local Job Seeker" }
  });

  await prisma.jobProfile.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      role: "Frontend Developer",
      seniority: "Middle",
      skills: ["React", "TypeScript", "Next.js"],
      location: "Remote",
      remoteOnly: true,
      salaryMin: 2500,
      includeKeywords: ["frontend", "react"],
      excludeKeywords: ["wordpress", "php"],
      matchThreshold: 60
    }
  });

  const dou = await prisma.source.upsert({
    where: { name: SourceName.DOU },
    update: {},
    create: { name: SourceName.DOU, baseUrl: "https://jobs.dou.ua" }
  });

  await prisma.source.upsert({
    where: { name: SourceName.DJINNI },
    update: {},
    create: { name: SourceName.DJINNI, baseUrl: "https://djinni.co/jobs" }
  });

  const description = "React TypeScript remote product role with Next.js experience.";
  await prisma.vacancy.upsert({
    where: { sourceUrl: "https://jobs.dou.ua/companies/sample/vacancies/1/" },
    update: {},
    create: {
      sourceId: dou.id,
      sourceUrl: "https://jobs.dou.ua/companies/sample/vacancies/1/",
      title: "Middle Frontend Developer",
      company: "Sample Product",
      location: "Remote",
      remoteType: "remote",
      salaryMin: 2500,
      salaryMax: 3500,
      salaryCurrency: "USD",
      description,
      skills: ["React", "TypeScript", "Next.js"],
      contentHash: createHash("sha256").update(description).digest("hex")
    }
  });
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
