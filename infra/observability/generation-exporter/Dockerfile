FROM public.ecr.aws/docker/library/golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS certificates
FROM public.ecr.aws/docker/library/debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
COPY --from=certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# Deployment supplies versions resolved and recorded in packages.lock. A missing
# or removed package version fails the build rather than silently upgrading.
ARG PYTHON_PACKAGE_VERSION=3.11.2-1+b1
ARG OPENSSH_PACKAGE_VERSION=1:9.2p1-2+deb12u10
RUN test -n "$PYTHON_PACKAGE_VERSION" && test -n "$OPENSSH_PACKAGE_VERSION" \
    && sed -i \
         -e 's|http://deb.debian.org/debian-security|https://security.debian.org/debian-security|g' \
         -e 's|https://deb.debian.org/debian-security|https://security.debian.org/debian-security|g' \
         -e 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' \
         -e 's|https://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' \
         /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "3";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80studiotv-network \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
         "python3=$PYTHON_PACKAGE_VERSION" "openssh-client=$OPENSSH_PACKAGE_VERSION" \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 generation-monitor \
    && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /nonexistent generation-monitor \
    && python3 -c 'import ssl; c=ssl.create_default_context(); assert c.check_hostname and c.verify_mode == ssl.CERT_REQUIRED and c.cert_store_stats()["x509_ca"] > 0'

COPY exporter.py /app/exporter.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 1000:1000
ENTRYPOINT ["/usr/bin/python3", "/app/exporter.py"]
