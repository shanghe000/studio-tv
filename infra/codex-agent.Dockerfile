# Codex itself is operator-provisioned as a read-only standalone binary, pinned
# and version-checked by the fixed-spec launcher; no operator HOME is mounted.
FROM public.ecr.aws/docker/library/golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS certificates
FROM public.ecr.aws/docker/library/debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
COPY --from=certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|https://security.debian.org/debian-security|g' \
      -e 's|https://deb.debian.org/debian-security|https://security.debian.org/debian-security|g' \
      -e 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' \
      -e 's|https://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' \
      /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "3";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80studiotv-network \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates iptables \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspace /runtime/codex /runtime/home /opt/codex
USER 11001:11001
WORKDIR /workspace
COPY infra/codex-agent-entrypoint.sh /usr/local/bin/studio-agent-entrypoint
ENTRYPOINT ["/bin/sh", "/usr/local/bin/studio-agent-entrypoint"]
