FROM public.ecr.aws/docker/library/docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d AS docker-cli
FROM public.ecr.aws/docker/library/python:3.11-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89
# Only the fixed launcher needs a Docker client; no daemon/containerd/runc.
COPY --from=docker-cli /usr/local/bin/docker /usr/bin/docker
COPY scripts/codex-agent-launcher.py /app/codex-agent-launcher.py
ENV PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["/usr/local/bin/python3", "/app/codex-agent-launcher.py"]
