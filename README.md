# Vacancy Radar

Local-first MVP for an individual job seeker who wants one radar for relevant tech vacancies from DOU and Djinni, with Telegram alerts for high-quality matches.

## MVP Scope

- One local user profile.
- Sources: DOU and Djinni.
- Notification channel: Telegram bot.
- Matching fields: role, seniority, skills, location, remote preference, salary range, include keywords, exclude keywords.
- New vacancy rule: a user is notified at most once per unique vacancy URL.

## Explicit Exclusions

- LinkedIn scraping is excluded. A later version can support LinkedIn via forwarded job-alert emails or approved API access.
- Multi-user teams, recruiter workflows, payments, and public marketplace features are out of scope for the MVP.

## Local Development

1. Copy environment values:

```bash
cp .env.example .env
```

2. Start infrastructure and apps:

```bash
docker compose up --build
```

3. Open:

- Web app: http://localhost:3000
- API: http://localhost:4000/health

## Useful Commands

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
npm test
```

## Telegram Setup

Create a bot with BotFather, put its token into `TELEGRAM_BOT_TOKEN`, then send a message to the bot. Use the Telegram chat ID in the web settings screen.

## Source Settings

DOU and Djinni search URLs are stored in the database and can be edited from the dashboard under Sources. Defaults are:

- DOU: `https://jobs.dou.ua/vacancies/?category=Front%20End`
- Djinni: `https://djinni.co/jobs/?primary_keyword=JavaScript`

The local MVP user identity can be configured with `APP_USER_EMAIL` and `APP_USER_NAME`.
