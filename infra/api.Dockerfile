FROM public.ecr.aws/docker/library/golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS build
WORKDIR /app/apps/api-go
COPY apps/api-go/go.mod apps/api-go/go.sum ./
COPY apps/api-go ./
COPY contracts /app/contracts
RUN CGO_ENABLED=0 go build -mod=vendor -trimpath -ldflags="-s -w" -o /app/bin/studiotv-api ./cmd/api \
 && CGO_ENABLED=0 go build -mod=vendor -trimpath -ldflags="-s -w" -o /app/bin/studiotv-migrate ./cmd/migrate

FROM public.ecr.aws/docker/library/debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS media-base
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|https://security.debian.org/debian-security|g' \
      -e 's|https://deb.debian.org/debian-security|https://security.debian.org/debian-security|g' \
      -e 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' \
      -e 's|https://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' \
      /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "3";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80studiotv-network \
    && apt-get update && apt-get install -y --no-install-recommends ffmpeg chromium chromium-sandbox fonts-liberation zstd ca-certificates \
 && rm -rf /var/lib/apt/lists/*

FROM media-base AS test
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/go /usr/local/go
COPY --from=build /app /app
ENV PATH="/usr/local/go/bin:${PATH}" CGO_ENABLED=0
WORKDIR /app/apps/api-go
CMD ["go", "test", "-count=1", "-v", "./..."]

FROM media-base AS runtime
RUN groupadd --gid 1000 studiotv && useradd --uid 1000 --gid studiotv --no-create-home studiotv \
 && mkdir -p /data/assets /home/studiotv /var/log/studio-tv && chown -R studiotv:studiotv /data /home/studiotv /var/log/studio-tv \
 && chmod 700 /home/studiotv
RUN mkdir -p /app/catalog/studio-character-media && chmod 755 /app/catalog/studio-character-media
COPY --from=build /app/bin/ /usr/local/bin/
COPY --chown=studiotv:studiotv contracts /app/contracts
COPY --chown=studiotv:studiotv apps/web/public/project/assets /app/catalog/project/assets
RUN find /app/contracts -type d -exec chmod 755 {} + \
 && find /app/contracts -type f -exec chmod 644 {} +
USER studiotv
ENV HOME=/home/studiotv HOST=0.0.0.0 PORT=3000 STORAGE_ROOT=/data/assets CONTRACT_PATH=/app/contracts/openapi.json PRODUCT_CATALOG_ROOT=/app/catalog
EXPOSE 3000
CMD ["sh", "-c", "studiotv-migrate && exec studiotv-api"]
