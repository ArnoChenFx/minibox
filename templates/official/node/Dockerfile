FROM node:26-bookworm-slim

# Box user convention, the same as templates/base. Change these only together with the volumes that already use them.
ARG DEV_UID=1000
ARG DEV_GID=1000

LABEL minibox.template=true \
      minibox.template.name=node \
      minibox.template.description="Debian 12 · Node.js 26 · pnpm · yarn · git · tmux · build-essential · non-root dev user" \
      minibox.template.user=dev \
      minibox.template.uid="${DEV_UID}" \
      minibox.template.gid="${DEV_GID}"

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git curl ca-certificates python3 build-essential procps vim-tiny less sudo \
      tmux jq ripgrep openssh-client openssh-sftp-server socat unzip iputils-ping \
 && rm -rf /var/lib/apt/lists/*

# Installed under /usr/local, so every user has them. node-gyp needs python3, which is installed above.
RUN npm install --global pnpm@12.15.0 yarn@1.22.22 \
 && npm cache clean --force

# The node image has a `node` user on uid/gid 1000. Remove it instead of renaming it, so `dev` takes the convention uid.
RUN if getent passwd node >/dev/null; then userdel node && rm -rf /home/node; fi \
 && if getent group node >/dev/null; then groupdel node; fi \
 && groupadd --gid "${DEV_GID}" dev \
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
