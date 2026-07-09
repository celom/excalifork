# Excalifork

A personal fork of [Excalidraw](https://github.com/excalidraw/excalidraw) focused on **local-first document management** and **easy self-hosting**.

> [!IMPORTANT]
> **This is not the official Excalidraw repository.** It is an independent fork and is not affiliated with or endorsed by the Excalidraw team. For the official editor, npm package, documentation, and Excalidraw+, go to [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw), [excalidraw.com](https://excalidraw.com), and [docs.excalidraw.com](https://docs.excalidraw.com).

## Why this fork exists

Upstream Excalidraw is a superb whiteboard, but the hosted app treats your work as a single canvas at a time — organizing many drawings is left to Excalidraw+ or your filesystem. This fork adds that organization layer directly to the self-hostable app:

- 🗂️ **Scenes & collections** — manage multiple drawings ("scenes") from a built-in sidebar, grouped into collections with custom icons.
- 🖼️ **Scene previews** — visual dashboard with live thumbnails, search, and drag-to-reorder.
- 💾 **Local-first** — scenes are stored in your browser; import and export everything as an archive for backup or migration.
- 📦 **Self-hosting first** — a ready-to-deploy Docker Compose setup (app + collaboration server), tested on ARM.
- 🧹 **No upsells** — Excalidraw+ promotions and related components are removed.

Everything else — the editor, tools, real-time collaboration, end-to-end encryption, PWA/offline support — is inherited from upstream, which this fork tracks and merges regularly.

## Self-hosting

The repo ships with [`docker-compose.selfhost.yml`](./docker-compose.selfhost.yml), which builds the app plus the [excalidraw-room](https://github.com/excalidraw/excalidraw-room) collaboration server from source (the published room image is amd64-only; building from source works on ARM hosts too).

```bash
VITE_APP_WS_SERVER_URL=https://room.your-domain.com \
  docker compose -f docker-compose.selfhost.yml up -d --build
```

Required configuration:

- `VITE_APP_WS_SERVER_URL` — the **public** URL you assign to the `excalidraw-room` service. The browser connects to it directly, so it must be reachable from outside, not the internal compose hostname.

Optional configuration (see the comments in the compose file for details):

- `VITE_APP_FIREBASE_CONFIG` — your own Firebase project for collab scene persistence and image sharing.
- `VITE_APP_BACKEND_V2_GET_URL` / `VITE_APP_BACKEND_V2_POST_URL` — self-hosted storage backend for "export to link".
- `VITE_APP_AI_BACKEND` — backend for AI features.

> [!NOTE]
> All `VITE_APP_*` values are baked into the static bundle at **build** time. Changing them requires a rebuild, not a restart.

For platforms like Coolify: create a Docker Compose resource pointing at `docker-compose.selfhost.yml`, set the env vars, and assign one domain to `excalidraw` and another to `excalidraw-room` (both on port 80).

## Development

```bash
yarn
yarn start            # run the app locally
yarn test:typecheck   # TypeScript type checking
yarn test:update      # run tests (with snapshot updates)
yarn fix              # auto-fix formatting and linting
```

The repository is a monorepo: the editor lives in `packages/` and the app in `excalidraw-app/`. Fork-specific features are concentrated in `excalidraw-app/scenes/` and `excalidraw-app/components/` (scenes sidebar, collection dashboard, archive import).

## Issues & contributions

- Problems with **fork features** (scenes, collections, self-hosting setup): [open an issue here](https://github.com/celom/excalidraw/issues).
- Problems with the **core editor**: they likely exist upstream too — please report them to [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw/issues) so everyone benefits.

## License & credit

MIT, same as upstream. All credit for the editor itself goes to the [Excalidraw project and its contributors](https://github.com/excalidraw/excalidraw/graphs/contributors) — if you find the whiteboard useful, consider [sponsoring them](https://opencollective.com/excalidraw) or checking out [Excalidraw+](https://plus.excalidraw.com).
