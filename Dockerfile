
FROM node:24-bookworm-slim AS clawchat-pi-agent-builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build/clawchat-pi-agent
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY README.md ./README.md
COPY docs ./docs
RUN npm run build \
  && npm pack --pack-destination /tmp

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

COPY --from=clawchat-pi-agent-builder /tmp/clawchat-pi-agent-*.tgz /tmp/clawchat-pi-agent.tgz
RUN npm install -g --ignore-scripts \
    @earendil-works/pi-coding-agent \
    /tmp/clawchat-pi-agent.tgz \
  && pi install /usr/local/lib/node_modules/clawchat-pi-agent \
  && rm /tmp/clawchat-pi-agent.tgz \
  && npm cache clean --force

WORKDIR /workspace
ENTRYPOINT ["pi"]
