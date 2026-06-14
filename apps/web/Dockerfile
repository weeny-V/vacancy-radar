FROM node:21-alpine
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install
COPY . .
RUN npm run build --workspace @vacancy-radar/web
CMD ["npm", "run", "start", "--workspace", "@vacancy-radar/web"]
