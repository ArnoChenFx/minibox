# The box image for the real-engine egress tests (tests/docker-egress.test.ts). curl makes the requests the tests send
# from a box, and ca-certificates lets them verify HTTPS. The rest is what exec, SSH and port previews need from a box:
# bash, socat, python3 (the preview relay), and a dev user on uid and gid 1000 that owns /workspace, as tests/fixtures/ssh
# has them.
FROM debian:bookworm-slim

LABEL minibox.template.uid="1000" \
      minibox.template.gid="1000"

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash ca-certificates curl socat python3 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 dev \
 && useradd --uid 1000 --gid dev --create-home --home-dir /home/dev --shell /bin/bash dev \
 && mkdir -p /workspace \
 && chown dev:dev /workspace

USER dev
WORKDIR /workspace
