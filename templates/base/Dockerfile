FROM node:24-bookworm-slim

LABEL minibox.template=true \
      minibox.template.name=base \
      minibox.template.description="Debian + Node 24 + git/curl/python3/build-essential"

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git curl ca-certificates python3 python3-pip python3-venv \
      build-essential procps vim-tiny less sudo \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash dev \
 && echo "dev ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dev \
 && chmod 0440 /etc/sudoers.d/dev \
 && visudo -cf /etc/sudoers.d/dev \
 && mkdir -p /workspace \
 && chown dev:dev /workspace

USER dev
ENV NPM_CONFIG_PREFIX=/home/dev/.npm-global \
    PATH=/home/dev/.npm-global/bin:$PATH
WORKDIR /workspace
CMD ["sleep", "infinity"]
