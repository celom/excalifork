FROM node:24-alpine

WORKDIR /app

COPY index.js ./

# The volume is mounted at /data; make it writable by the unprivileged user the
# base image already provides.
RUN mkdir -p /data && chown -R node:node /data /app

USER node

ENV PORT=80 \
    DATA_DIR=/data

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://localhost/healthz || exit 1

CMD ["node", "index.js"]
