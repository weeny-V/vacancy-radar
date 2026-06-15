import { PrismaClient, SourceName } from "@prisma/client";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const prisma = new PrismaClient();

const appUserEmail = process.env.APP_USER_EMAIL ?? "local@vacancy-radar.dev";
const appUserName = process.env.APP_USER_NAME ?? "Local Job Seeker";
const appUserPassword = process.env.APP_USER_PASSWORD ?? "vacancy-radar-local";

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, storedHash: string) {
  const [, salt, expected] = storedHash.split("$");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(Buffer.from(expected, "hex"), actual);
}

async function main() {
  const existingUser = await prisma.user.findUnique({ where: { email: appUserEmail } });
  const passwordHash = existingUser?.passwordHash && verifyPassword(appUserPassword, existingUser.passwordHash)
    ? existingUser.passwordHash
    : hashPassword(appUserPassword);

  const user = await prisma.user.upsert({
    where: { email: appUserEmail },
    update: { name: appUserName, passwordHash },
    create: { email: appUserEmail, name: appUserName, passwordHash }
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
