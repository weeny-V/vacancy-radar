FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install
COPY . .
RUN npm run prisma:generate && npm run build --workspace @vacancy-radar/shared && npm run build --workspace @vacancy-radar/api
CMD ["sh", "-c", "npm run prisma:migrate:deploy && npm run start --workspace @vacancy-radar/api"]
