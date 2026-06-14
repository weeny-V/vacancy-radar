FROM node:21-alpine
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install
COPY . .
RUN npm run prisma:generate && npm run build --workspace @vacancy-radar/shared && npm run build --workspace @vacancy-radar/api
CMD ["sh", "-c", "npm run prisma:push && npm run prisma:seed && npm run start --workspace @vacancy-radar/api"]
