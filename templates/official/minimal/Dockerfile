FROM debian:bookworm-slim

# Box user convention, the same as templates/base. Change these only together with the volumes that already use them.
ARG DEV_UID=1000
ARG DEV_GID=1000

LABEL minibox.template=true \
      minibox.template.name=minimal \
      minibox.template.description="Debian 12 · git · tmux · jq · ripgrep · non-root dev user" \
      minibox.template.user=dev \
      minibox.template.uid="${DEV_UID}" \
      minibox.template.gid="${DEV_GID}"

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git curl ca-certificates procps vim-tiny less sudo \
      tmux jq ripgrep openssh-client openssh-sftp-server socat unzip iputils-ping \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid "${DEV_GID}" dev \
 && useradd --uid "${DEV_UID}" --gid dev --create-home --home-dir /home/dev --shell /bin/bash dev \
 && echo "dev ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dev \
 && chmod 0440 /etc/sudoers.d/dev \
 && visudo -cf /etc/sudoers.d/dev

# Mount points for the box volumes. The tools volume is read-only inside boxes, so /opt/minibox/tools/bin stays root-owned.
RUN mkdir -p /workspace /opt/minibox/tools/bin /home/dev/.cache \
 && chown dev:dev /workspace /home/dev/.cache

# Debian's /etc/profile resets PATH for non-root login shells, and the web terminal starts `bash -l`.
RUN printf '%s\n' 'export PATH="/home/dev/.npm-global/bin:$PATH:/opt/minibox/tools/bin"' > /etc/profile.d/minibox.sh

ENV NPM_CONFIG_PREFIX=/home/dev/.npm-global \
    PATH=/home/dev/.npm-global/bin:$PATH:/opt/minibox/tools/bin \
    XDG_CACHE_HOME=/home/dev/.cache \
    npm_config_cache=/home/dev/.cache/npm \
    PIP_CACHE_DIR=/home/dev/.cache/pip \
    YARN_CACHE_FOLDER=/home/dev/.cache/yarn

USER dev
WORKDIR /workspace
CMD ["sleep", "infinity"]
