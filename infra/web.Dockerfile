FROM node:22-bookworm-slim@sha256:3ed748ce9dea62d2f0f0205cdbb6823106d9f973a6f555c402fe2575f8d6e1ae AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/web apps/web
RUN npm run build --workspace @studiotv/web
# Sidecars are generated from image build output only; frozen public sources
# are copied unchanged. Runtime configuration is generated at container start.
RUN node --input-type=module -e '\
import fs from "node:fs"; \
import path from "node:path"; \
import { gzipSync } from "node:zlib"; \
function compress(dir) { \
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { \
    const file = path.join(dir, entry.name); \
    if (entry.isDirectory()) compress(file); \
    else if (entry.isFile() && /\.(js|css)$/.test(entry.name) && entry.name !== "runtime-config.js") { \
      const source = fs.readFileSync(file); \
      if (source.length >= 1024) fs.writeFileSync(file + ".gz", gzipSync(source, { level: 9 })); \
    } \
  } \
} \
compress("/app/apps/web/dist");'

FROM public.ecr.aws/docker/library/nginx:stable-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
RUN find /usr/share/nginx/html -type d -exec chmod 755 {} + && find /usr/share/nginx/html -type f -exec chmod 644 {} +
COPY infra/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh
ENV RHTV_MODE=service RHTV_EDITION=internal
EXPOSE 80
