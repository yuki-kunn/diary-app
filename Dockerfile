FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
# 永続化するデータ(SQLite)は /app/data に置く — デプロイ先でボリュームをマウントすること
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server.js"]
