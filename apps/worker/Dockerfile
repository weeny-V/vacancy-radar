FROM node:21-alpine
WORKDIR /app
COPY package*.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install
COPY . .
RUN npm run prisma:generate && npm run build --workspace @vacancy-radar/shared && npm run build --workspace @vacancy-radar/worker
CMD ["npm", "run", "start", "--workspace", "@vacancy-radar/worker"]
