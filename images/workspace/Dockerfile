# Base image for a Loom workspace container. One container per workspace runs everything
# that executes project code: agents, terminals, the setup script and dev servers.
FROM node:24-bookworm-slim

# The runner writes the checkout from outside and the agent from inside, so the container
# user carries the runner's own user and group numbers.
ARG LOOM_UID=1000
ARG LOOM_GID=1000

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl gh git less openssh-client procps ripgrep util-linux zsh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

# The base image's own user would otherwise share the common first number, 1000.
RUN userdel --remove node \
  && (getent group "${LOOM_GID}" >/dev/null || groupadd --gid "${LOOM_GID}" loom) \
  && useradd --uid "${LOOM_UID}" --gid "${LOOM_GID}" --create-home --shell /bin/zsh loom

USER loom
WORKDIR /home/loom

# The main process only idles; the runner starts every real process with `docker exec`.
CMD ["sleep", "infinity"]
