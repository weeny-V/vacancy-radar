import { PrismaClient, SourceName } from "@prisma/client";

const prisma = new PrismaClient();

const appUserEmail = process.env.APP_USER_EMAIL ?? "local@vacancy-radar.dev";
const appUserName = process.env.APP_USER_NAME ?? "Local Job Seeker";

async function main() {
  const user = await prisma.user.upsert({
    where: { email: appUserEmail },
    update: {},
    create: { email: appUserEmail, name: appUserName }
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

  await prisma.source.upsert({
    where: { name: SourceName.DOU },
    update: {},
    create: {
      name: SourceName.DOU,
      baseUrl: "https://jobs.dou.ua",
      searchUrl: "https://jobs.dou.ua/vacancies/?category=Front%20End",
      queryLabel: "Front End"
    }
  });

  await prisma.source.upsert({
    where: { name: SourceName.DJINNI },
    update: {},
    create: {
      name: SourceName.DJINNI,
      baseUrl: "https://djinni.co/jobs",
      searchUrl: "https://djinni.co/jobs/?primary_keyword=JavaScript",
      queryLabel: "JavaScript"
    }
  });

}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
