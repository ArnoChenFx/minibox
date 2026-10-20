FROM node:24-bookworm-slim

LABEL minibox.template=true \
      minibox.template.name=base \
      minibox.template.description="Debian + Node 24 + git/curl/python3/build-essential"

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git curl ca-certificates python3 python3-pip python3-venv \
      build-essential procps vim-tiny less \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
CMD ["sleep", "infinity"]
