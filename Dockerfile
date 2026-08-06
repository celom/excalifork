FROM --platform=${BUILDPLATFORM} node:24@sha256:8530f76a96d88820d288761f022e318970dda93d01536919fbc16076b7983e63 AS build

WORKDIR /opt/node_app

COPY . .

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN --mount=type=cache,target=/root/.cache/yarn \
    npm_config_target_arch=${TARGETARCH} yarn --frozen-lockfile --network-timeout 600000

ARG NODE_ENV=production

# Optional build-time overrides for self-hosting. When an arg is not
# provided it stays unset and Vite falls back to .env.production.
ARG VITE_APP_WS_SERVER_URL
ARG VITE_APP_FIREBASE_CONFIG
ARG VITE_APP_BACKEND_V2_GET_URL
ARG VITE_APP_BACKEND_V2_POST_URL
ARG VITE_APP_AI_BACKEND
ARG VITE_APP_ENABLE_TRACKING
ARG VITE_APP_ENABLE_AUTH

RUN npm_config_target_arch=${TARGETARCH} yarn build:app:docker

FROM nginx:stable-alpine-slim@sha256:2c605dbeab79a6b2a63340474fe58119d0ef95bdc4b1f41df0aa689659b3d13b

COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html

# Rendered into /etc/nginx/conf.d/ by the image's entrypoint, which substitutes
# FIREBASE_AUTH_HOST and NGINX_LOCAL_RESOLVERS. The latter is only populated
# when NGINX_ENTRYPOINT_LOCAL_RESOLVERS is set.
COPY docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
ENV FIREBASE_AUTH_HOST=""

HEALTHCHECK CMD wget -q -O /dev/null http://localhost || exit 1
