# OpenCode agent image with the Chorus plugin baked in.
# Used by docker-compose to run agents that talk to a host-side chorus-relay.
FROM debian:bookworm-slim

ARG OPENCODE_VERSION=1.18.11
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip python3 \
  && rm -rf /var/lib/apt/lists/*

# Install OpenCode CLI
RUN set -eux; \
  arch="${TARGETARCH:-amd64}"; \
  case "$arch" in \
    amd64|x86_64) asset="opencode-linux-x64.tar.gz" ;; \
    arm64|aarch64) asset="opencode-linux-arm64.tar.gz" ;; \
    *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${asset}" \
    -o /tmp/opencode.tgz; \
  mkdir -p /opt/opencode; \
  tar -xzf /tmp/opencode.tgz -C /opt/opencode; \
  bin="$(find /opt/opencode -type f -name opencode | head -n1)"; \
  install -m 0755 "$bin" /usr/local/bin/opencode; \
  rm -rf /tmp/opencode.tgz /opt/opencode; \
  opencode --version

# Bun for installing plugin runtime deps
RUN curl -fsSL https://bun.sh/install | bash \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun

# Chorus build artifacts (compose build context = repo root; run `bun run build` first)
COPY packages/shared/package.json /opt/chorus/packages/shared/package.json
COPY packages/shared/dist /opt/chorus/packages/shared/dist
COPY packages/plugin/package.json /opt/chorus/packages/plugin/package.json
COPY packages/plugin/dist /opt/chorus/packages/plugin/dist
COPY packages/plugin/commands /opt/chorus/packages/plugin/commands
COPY docker/opencode-agent/patch-packages.py /opt/chorus/packages/plugin/patch-packages.py

# Point @chorus/shared at the sibling package and install plugin deps
WORKDIR /opt/chorus/packages/plugin
ARG OPENCODE_VERSION
RUN python3 patch-packages.py \
  && bun install --production \
  && bun add "@opencode-ai/plugin@${OPENCODE_VERSION}" --exact \
  && rm -f patch-packages.py

# Agent workspace
WORKDIR /workspace
RUN mkdir -p /workspace/.opencode/plugins \
      /workspace/xdg-config/opencode/commands \
      /workspace/xdg-data \
  && printf '%s\n' 'export { default } from "/opt/chorus/packages/plugin/dist/index.js";' \
       > /workspace/.opencode/plugins/chorus.ts \
  && printf '%s\n' '{' '  "$schema": "https://opencode.ai/config.json"' '}' \
       > /workspace/opencode.json \
  && cp /opt/chorus/packages/plugin/commands/*.md /workspace/xdg-config/opencode/commands/ \
  && printf '%s\n' '# chorus docker agent workspace' > /workspace/README.md

ENV XDG_CONFIG_HOME=/workspace/xdg-config \
    XDG_DATA_HOME=/workspace/xdg-data \
    OPENCODE_CONFIG_DIR=/workspace/xdg-config/opencode \
    OPENCODE_PORT=4096 \
    CHORUS_RELAY_HOST=host.docker.internal:7742 \
    CHORUS_PUBLIC_HOST=host.docker.internal:7742

EXPOSE 4096

COPY docker/opencode-agent/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
