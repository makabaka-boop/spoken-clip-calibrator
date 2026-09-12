# 单阶段镜像：既托管静态页面（default 命令），也可作为一次性验收环境。
FROM node:20-bookworm-slim

WORKDIR /app

# 先装依赖以利用层缓存；Playwright Chromium 及其系统库仅验收服务用到。
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
  && npx --yes playwright install --with-deps chromium \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY . .

RUN npm run build

# 默认托管构建产物；verify 服务在 compose 中覆盖为一次性命令。
EXPOSE 8080
CMD ["npm", "run", "preview", "--", "--port", "8080", "--strictPort"]
