# The box image for the real-engine SSH tests (tests/docker-ssh.test.ts). It has what the SSH gateway needs from
# templates/base: openssh-sftp-server for the sftp subsystem, socat for local forwards, bash, and a dev user on uid and gid
# 1000 that owns /workspace. It is Debian 12 like the base template, so the sftp-server path is the same.
FROM debian:bookworm-slim

LABEL minibox.template.uid="1000" \
      minibox.template.gid="1000"

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash openssh-sftp-server socat \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 dev \
 && useradd --uid 1000 --gid dev --create-home --home-dir /home/dev --shell /bin/bash dev \
 && mkdir -p /workspace \
 && chown dev:dev /workspace

USER dev
WORKDIR /workspace
