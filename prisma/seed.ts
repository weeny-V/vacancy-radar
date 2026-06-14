import { PrismaClient, SourceName } from "@prisma/client";

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

  await prisma.source.upsert({
    where: { name: SourceName.DOU },
    update: {},
    create: { name: SourceName.DOU, baseUrl: "https://jobs.dou.ua" }
  });

  await prisma.source.upsert({
    where: { name: SourceName.DJINNI },
    update: {},
    create: { name: SourceName.DJINNI, baseUrl: "https://djinni.co/jobs" }
  });

}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
