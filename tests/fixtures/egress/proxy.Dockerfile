# Stands in for the base template in the real-engine egress tests. The egress proxy runs the base template's image and
# starts its program with `node -e`, so this image only has to carry Node.
FROM node:26-bookworm-slim
