export type SourceName = "DOU" | "DJINNI";

export interface JobProfileInput {
  role: string;
  seniority: string;
  skills: string[];
  location?: string | null;
  remoteOnly: boolean;
  salaryMin?: number | null;
  includeKeywords: string[];
  excludeKeywords: string[];
  matchThreshold: number;
}

export interface NormalizedVacancy {
  source: SourceName;
  sourceUrl: string;
  title: string;
  company?: string | null;
  location?: string | null;
  remoteType?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  description: string;
  skills: string[];
  publishedAt?: Date | null;
  contentHash: string;
}

export interface MatchResult {
  score: number;
  reasons: string[];
  blocked: boolean;
}

const normalize = (value: string) => value.toLowerCase().trim();

const containsAny = (haystack: string, needles: string[]) =>
  needles.some((needle) => haystack.includes(normalize(needle)));

export function scoreVacancy(profile: JobProfileInput, vacancy: NormalizedVacancy): MatchResult {
  const searchable = normalize([
    vacancy.title,
    vacancy.company,
    vacancy.location,
    vacancy.remoteType,
    vacancy.description,
    vacancy.skills.join(" ")
  ].filter(Boolean).join(" "));

  const excluded = profile.excludeKeywords.filter((keyword) => searchable.includes(normalize(keyword)));
  if (excluded.length > 0) {
    return {
      score: 0,
      blocked: true,
      reasons: [`Blocked by excluded keyword: ${excluded.join(", ")}`]
    };
  }

  let score = 0;
  const reasons: string[] = [];

  if (containsAny(searchable, [profile.role])) {
    score += 25;
    reasons.push(`Role match: ${profile.role}`);
  }

  if (containsAny(searchable, [profile.seniority])) {
    score += 15;
    reasons.push(`Seniority match: ${profile.seniority}`);
  }

  const matchedSkills = profile.skills.filter((skill) => searchable.includes(normalize(skill)));
  if (matchedSkills.length > 0) {
    score += Math.min(30, matchedSkills.length * 10);
    reasons.push(`Skills match: ${matchedSkills.join(", ")}`);
  }

  if (profile.remoteOnly && searchable.includes("remote")) {
    score += 15;
    reasons.push("Remote match");
  } else if (!profile.remoteOnly && profile.location && searchable.includes(normalize(profile.location))) {
    score += 10;
    reasons.push(`Location match: ${profile.location}`);
  }

  if (profile.salaryMin && vacancy.salaryMin && vacancy.salaryMin >= profile.salaryMin) {
    score += 10;
    reasons.push(`Salary match: ${vacancy.salaryMin}+ ${vacancy.salaryCurrency ?? ""}`.trim());
  } else if (!profile.salaryMin || !vacancy.salaryMin) {
    reasons.push("Salary not provided or not required");
  }

  const included = profile.includeKeywords.filter((keyword) => searchable.includes(normalize(keyword)));
  if (included.length > 0) {
    score += Math.min(10, included.length * 5);
    reasons.push(`Keyword match: ${included.join(", ")}`);
  }

  return {
    score: Math.min(100, score),
    blocked: false,
    reasons: reasons.length > 0 ? reasons : ["No strong match signals found"]
  };
}

export function canonicalizeUrl(url: string) {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

export function formatTelegramMessage(vacancy: NormalizedVacancy, match: MatchResult) {
  const salary = vacancy.salaryMin
    ? `${vacancy.salaryMin}${vacancy.salaryMax ? `-${vacancy.salaryMax}` : "+"} ${vacancy.salaryCurrency ?? ""}`.trim()
    : "Salary not provided";

  return [
    `New ${match.score}% match: ${vacancy.title}`,
    vacancy.company ? `Company: ${vacancy.company}` : null,
    vacancy.location ? `Location: ${vacancy.location}` : null,
    `Salary: ${salary}`,
    `Why: ${match.reasons.join("; ")}`,
    vacancy.sourceUrl
  ].filter(Boolean).join("\n");
}
