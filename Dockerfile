# Stage 1: Build
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Stage 2: Runtime
FROM node:20-alpine
WORKDIR /app

RUN addgroup -g 1001 mcp && adduser -u 1001 -G mcp -s /bin/sh -D mcp
USER mcp

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

ENV NODE_ENV=production
ENV MCP_HTTP_PORT=3003

EXPOSE 3003

CMD ["node", "dist/index.js"]
