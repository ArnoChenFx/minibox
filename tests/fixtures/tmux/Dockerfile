# The box image for the real-engine session tests (tests/docker-sessions.test.ts). It has what a session needs from the
# base template: tmux, bash, and a dev user on uid and gid 1000 that owns /workspace. It is built on alpine so the
# suite does not pull the whole template.
FROM alpine:3.20

RUN apk add --no-cache bash tmux \
 && addgroup -g 1000 dev \
 && adduser -D -u 1000 -G dev -h /home/dev -s /bin/bash dev \
 && mkdir -p /workspace \
 && chown dev:dev /workspace

USER dev
WORKDIR /workspace
