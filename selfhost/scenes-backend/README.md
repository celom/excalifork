# scenes-backend

Share-link storage for a self-hosted Excalidraw — the `excalidraw-scenes` service in `docker-compose.selfhost.yml`.

It exists because `json.excalidraw.com`, the default `VITE_APP_BACKEND_V2_*` target, only returns CORS headers to origins on its own allowlist. From any self-hosted domain the POST succeeds but the browser blocks the response, and the app reports "Couldn't create shareable link".

## Contract

```
POST <base>/api/v2/scenes      raw body  -> {"id": "..."}
GET  <base>/api/v2/scenes/<id>           -> the same bytes
GET  /healthz                            -> ok
```

The `json.excalidraw.com` path shape is accepted as well, so pointing an existing `VITE_APP_BACKEND_V2_*` pair at this host works by changing only the domain — swapping just the host is the obvious thing to try, and 404ing it would be a trap:

```
POST <base>/api/v2/post/       raw body  -> {"id": "..."}
GET  <base>/api/v2/<id>                  -> the same bytes
```

Ids are interchangeable between the two: a scene created through one shape reads back through the other.

Ids are base64url, matching the share-link hash regex the app parses on load (`excalidraw-app/App.tsx:238`). The GET build arg needs a trailing slash — the app concatenates the id straight onto it (`excalidraw-app/data/index.ts:207`).

Node stdlib only: no dependencies, no install step, no lockfile, nothing to patch for CVEs. Runs as the unprivileged `node` user.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | _(empty = any)_ | Comma-separated, matched exactly, scheme included |
| `MAX_SCENE_BYTES` | `10485760` | Past this the app shows its "too big" message |
| `DATA_DIR` | `/data` | Where scenes are written, sharded two chars deep |
| `BASE_PATH` | `/api/v2/scenes` | Stripped if present, so a path-routed proxy can forward either form |
| `PORT` | `80` | Bindable as non-root; Docker sets `ip_unprivileged_port_start=0` |

Leaving `ALLOWED_ORIGINS` empty allows every origin and is only sensible on a private network. The compose file requires it.

## Backups

**The volume is the only copy.** Scenes are encrypted in the browser and the key lives in the URL fragment, so the bytes here are opaque — but losing the volume breaks every link ever shared from this instance, and nothing can reconstruct them.

```bash
docker run --rm -v excalifork_scenes-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/scenes-$(date +%F).tar.gz -C /data .
```

Restore by extracting back into the volume. Substitute your compose project's volume name — `docker volume ls` if unsure.

Files are written to a temporary name and renamed into place, so an interrupted write can't leave a truncated scene behind a live id.
