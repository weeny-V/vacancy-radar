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

Prerequisite: Node.js 22 LTS. If you use `nvm`, run:

```bash
nvm use
```

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

4. Sign in with the `APP_USER_EMAIL` and `APP_USER_PASSWORD` values from `.env`.

## Useful Commands

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:migrate:deploy
npm run prisma:seed
npm run dev
npm test
```

## Database Lifecycle

Schema changes are tracked as Prisma migrations in `prisma/migrations`.

Local development:

```bash
npm run prisma:migrate
npm run prisma:seed
```

Production or Docker startup:

```bash
npm run prisma:migrate:deploy
```

Seeding is not part of production startup. Run `npm run prisma:seed` only when you intentionally want to create or update the local MVP user/profile/source defaults.

If you already created a local database with the earlier `prisma db push` flow, mark the initial migration as applied once:

```bash
npm run prisma:migrate:baseline
```

## Telegram Setup

Create a bot with BotFather, put its token into `TELEGRAM_BOT_TOKEN`, then send a message to the bot. Use the Telegram chat ID in the web settings screen.

## Source Settings

DOU and Djinni search URLs are stored in the database and can be edited from the dashboard under Sources. Defaults are:

- DOU: `https://jobs.dou.ua/vacancies/?category=Front%20End`
- Djinni: `https://djinni.co/jobs/?primary_keyword=JavaScript`

The local MVP user identity can be configured with `APP_USER_EMAIL` and `APP_USER_NAME`.

## Authentication

The app uses a password login, HTTP-only session cookie, and CSRF tokens for state-changing API requests. Configure:

- `APP_USER_EMAIL`
- `APP_USER_NAME`
- `APP_USER_PASSWORD`
- `AUTH_SECRET`

For production, `AUTH_SECRET` and `APP_USER_PASSWORD` must be changed from the local defaults.

## Rate Limits

Login attempts are limited per IP and email. Manual admin fetches are limited per user. Configure:

- `LOGIN_RATE_LIMIT_MAX`
- `LOGIN_RATE_LIMIT_WINDOW_SECONDS`
- `ADMIN_FETCH_RATE_LIMIT_MAX`
- `ADMIN_FETCH_RATE_LIMIT_WINDOW_SECONDS`

## Scheduled Fetching

The worker schedules automatic DOU and Djinni polling with BullMQ repeatable jobs. Configure:

- `SCHEDULED_FETCH_ENABLED`
- `DOU_FETCH_INTERVAL_MINUTES`
- `DJINNI_FETCH_INTERVAL_MINUTES`

Intervals must be at least 1 minute. Manual "Run fetch" still works independently.
