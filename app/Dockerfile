FROM node:22-alpine AS build

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --config.minimum-release-age=0
COPY . .
RUN pnpm build

FROM nginx:1.27-alpine
# `.template` files here are rendered with `envsubst` (only for names that
# are actual environment variables in the container, so nginx's own `$host`
# etc. are left untouched) by the base image's entrypoint at startup, into
# `/etc/nginx/conf.d/default.conf` - keeps `client_max_body_size` in sync
# with `MAX_UPLOAD_MB` (issue #47) without a custom entrypoint script.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
