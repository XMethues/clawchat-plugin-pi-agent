
FROM node:24-bookworm-slim AS clawchat-plugin-builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build/clawchat-pi
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

COPY --from=clawchat-plugin-builder /tmp/newbase-clawchat-clawchat-pi-*.tgz /tmp/clawchat-pi.tgz
RUN npm install -g --ignore-scripts \
    @earendil-works/pi-coding-agent \
    /tmp/clawchat-pi.tgz \
  && pi install /usr/local/lib/node_modules/@newbase-clawchat/clawchat-pi \
  && rm /tmp/clawchat-pi.tgz \
  && npm cache clean --force

WORKDIR /workspace
ENTRYPOINT ["pi"]
