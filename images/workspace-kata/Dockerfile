# Build the existing workspace image first. Only Kata workspaces use this service image.
ARG WORKSPACE_IMAGE=loom-workspace:latest
FROM docker:29.9.3-dind AS engine
FROM ${WORKSPACE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap e2fsprogs iproute2 iptables kmod nftables socat tini \
  && rm -rf /var/lib/apt/lists/*
COPY --from=engine /usr/local/bin/docker /usr/local/bin/dockerd /usr/local/bin/runc /usr/local/bin/docker-init /usr/local/bin/docker-proxy /usr/local/bin/
COPY --from=engine /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
# Use a verified standalone containerd instead of Docker's experimental embedded fallback.
RUN test "$(uname -m)" = x86_64 \
  && curl -fsSL --retry 3 https://github.com/containerd/containerd/releases/download/v2.4.2/containerd-static-2.4.2-linux-amd64.tar.gz -o /tmp/containerd.tar.gz \
  && echo 'da656542e754c699a0f438eab925e6ffdbd6346a4428e659f83dc058f04dcffe  /tmp/containerd.tar.gz' | sha256sum -c - \
  && tar -xzf /tmp/containerd.tar.gz -C /usr/local bin/containerd bin/containerd-shim-runc-v2 bin/ctr \
  && rm /tmp/containerd.tar.gz
COPY entrypoint.sh /usr/local/sbin/loom-kata-init
RUN chmod 0755 /usr/local/sbin/loom-kata-init
HEALTHCHECK --interval=5s --timeout=3s --start-period=120s CMD docker info >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/usr/local/sbin/loom-kata-init"]
CMD []
