# The box image for the real-engine session tests (tests/docker-sessions.test.ts) and the startup command tests. It has what
# they need from the base template: tmux, bash, sudo for dev as the base template grants it, and a dev user on uid and gid
# 1000 that owns /workspace. sudo runs its command in a pty, as Debian's sudoers does in the base template. It is built on
# alpine so the suite does not pull the whole template.
FROM alpine:3.20

LABEL minibox.template.uid="1000" \
      minibox.template.gid="1000"

RUN apk add --no-cache bash tmux sudo \
 && addgroup -g 1000 dev \
 && adduser -D -u 1000 -G dev -h /home/dev -s /bin/bash dev \
 && echo "Defaults use_pty" >> /etc/sudoers \
 && echo "dev ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers \
 && mkdir -p /workspace \
 && chown dev:dev /workspace

USER dev
WORKDIR /workspace
