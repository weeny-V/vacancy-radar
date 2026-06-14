import { describe, expect, it } from "vitest";
import { formatTelegramMessage, NormalizedVacancy, scoreVacancy } from "@vacancy-radar/shared";

const profile = {
  role: "Frontend Developer",
  seniority: "Middle",
  skills: ["React", "TypeScript", "Next.js"],
  location: "Remote",
  remoteOnly: true,
  salaryMin: 2500,
  includeKeywords: ["frontend"],
  excludeKeywords: ["wordpress"],
  matchThreshold: 60
};

const vacancy: NormalizedVacancy = {
  source: "DOU",
  sourceUrl: "https://jobs.dou.ua/sample",
  title: "Middle Frontend Developer",
  company: "Product",
  location: "Remote",
  remoteType: "remote",
  salaryMin: 3000,
  salaryMax: 4000,
  salaryCurrency: "USD",
  description: "React TypeScript Next.js role",
  skills: ["React", "TypeScript", "Next.js"],
  contentHash: "hash"
};

describe("matching", () => {
  it("scores a strong matching vacancy above threshold", () => {
    const result = scoreVacancy(profile, vacancy);
    expect(result.blocked).toBe(false);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.reasons.join(" ")).toContain("React");
  });

  it("blocks vacancies with excluded keywords", () => {
    const result = scoreVacancy(profile, { ...vacancy, description: "WordPress PHP role" });
    expect(result.blocked).toBe(true);
    expect(result.score).toBe(0);
  });

  it("formats telegram alerts with match reasons", () => {
    const result = scoreVacancy(profile, vacancy);
    const message = formatTelegramMessage(vacancy, result);
    expect(message).toContain("Middle Frontend Developer");
    expect(message).toContain("Why:");
    expect(message).toContain(vacancy.sourceUrl);
  });
});
