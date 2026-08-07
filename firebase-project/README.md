# Firebase project

Backing services for a self-hosted Excalidraw.

| Piece | Serves |
| --- | --- |
| `storage.rules` | Images in shared links and collab rooms; per-user scene payloads |
| `firestore.rules` | Collab room persistence; per-user workspace metadata |
| Authentication | Google sign-in for per-user cloud storage |

The app reaches all of them through the client SDK using `VITE_APP_FIREBASE_CONFIG`. That path authorizes with the web API key and security rules, not IAM.

## Google sign-in

Off unless `VITE_APP_ENABLE_AUTH=true` is set at build time. It is a separate flag from `VITE_APP_FIREBASE_CONFIG` on purpose: `.env.production` still carries upstream's `excalidraw-room-persistence` config, so a build that enables auth without also overriding the config would render a sign-in button pointed at a project nobody here controls. The flag fails closed; inferring availability from the config would not.

To turn it on:

1. Firebase console → Authentication → Sign-in method → enable **Google**.
2. Authentication → Settings → Authorized domains → add the deployment's domain (`localhost` is present by default for dev).
3. Build with both `VITE_APP_ENABLE_AUTH=true` and this project's `VITE_APP_FIREBASE_CONFIG`.

The org policies that blocked Cloud Functions (below) do **not** apply here. They constrain IAM principals; Firebase Auth end users are not IAM principals, and sign-in authorizes through the web API key and security rules — the same path Firestore and Storage already use in this project. The one consequence that does carry over: `constraints/iam.disableServiceAccountKeyCreation` means no Admin SDK key exists anywhere, so nothing server-side can mint or verify tokens. Everything is client SDK plus rules.

### Where a signed-in user's scenes live

```
Firestore  users/{uid}/workspace/index    the scenes index — metadata only
Storage    users/{uid}/scenes/{sceneId}   one gzipped scene payload per scene
Storage    users/{uid}/files/{fileId}     image files, content-addressed
```

Metadata and payloads are split because Firestore documents cap at 1 MiB and scenes have no such bound, and because the index is what every device reads on every sync pass — keeping payloads out of it makes that read cheap and makes an `onSnapshot` listener a viable live-update channel between devices.

`excalidraw-app/scenes/cloudSync.ts` drives it; the merge rules it runs on are in `cloudMerge.ts`, kept pure and directly tested because they are the part that can lose a drawing. The short version: per-scene last-write-wins on `updatedAt`, deletions carried as tombstones so a delete on one device isn't undone by the next push from another, and metadata synced ahead of payloads.

That last split is what a new device sees: the index doc arrives in one read, then a drain at the end of the pass downloads the blobs one at a time (`drainPendingScenes`). Until a blob lands its scene sits in the index as `materialized: false` and every read path refuses it — an undownloaded scene read as an empty one would replicate that emptiness back over the real data. Opening a scene the drain hasn't reached fetches it on the spot, de-duplicated against the drain's own download.

Downloading everything has a known limit: an account can hold far more than one browser's ~5MB of localStorage. The drain is sequential and stops at the first `QuotaExceededError` rather than re-hitting it once per scene; what it couldn't fetch stays listed, still opens on demand, and is retried on the next pass. `excalidraw-app/tests/cloudDrain.test.ts` pins that down, along with the partial-write cleanup — a payload that fails halfway must leave no keys behind, since a half-written blob under a scene id is indistinguishable from a real one. Lifting the ceiling means moving scene blobs to IndexedDB, which is what the `ScenesStorageAdapter` seam in `scenes/storage.ts` exists for.

### Bucket CORS is required for downloads

Reading a scene blob in the browser needs CORS configured on the bucket. Without it, `getBytes` fails with `No 'Access-Control-Allow-Origin' header is present on the requested resource`.

An earlier version of this file claimed otherwise, on the strength of an `OPTIONS` probe. That probe is misleading, and it is worth spelling out why so nobody re-runs it and draws the same conclusion. The two halves of the request are served by different things:

- the **preflight**, and any response the Firebase layer generates itself (a `403` from a rules denial, a `404`), come from `firebasestorage.googleapis.com` and always carry `access-control-allow-origin: *`
- the **successful download body** (`?alt=media`) is served through from GCS and carries no `access-control-allow-origin` header at all unless the bucket has a CORS policy

So the preflight passes, the rules pass, the object is returned with `200`, and the browser then drops it. Probing with `OPTIONS` — or with any request that gets rejected before it reaches the object — tests only the half that was never the problem.

Check the half that matters, on an object that actually reads. `access-control-allow-origin` must be present here:

```bash
curl -sD - -o /dev/null \
  "https://firebasestorage.googleapis.com/v0/b/excalifork-40f48.firebasestorage.app/o/<readable-object>?alt=media" \
  -H "Origin: https://excalifork.com" | grep -i access-control
```

To set the policy:

```bash
cat > cors.json <<'EOF'
[
  {
    "origin": ["https://excalifork.com", "http://localhost:3000"],
    "method": ["GET"],
    "responseHeader": ["Content-Type", "Content-Range", "Content-Encoding", "Range", "Authorization"],
    "maxAgeSeconds": 3600
  }
]
EOF
gcloud storage buckets update gs://excalifork-40f48.firebasestorage.app --cors-file=cors.json
```

This is bucket state, not part of `firebase deploy` — a project rebuilt from this repo needs it applied separately from the rules.

### Scene blobs are gzipped by the app, not by the transport

`cloudStorage.ts` compresses payloads with fflate and stores the result as `application/octet-stream`. It deliberately does **not** set `contentEncoding: "gzip"` on the object. Doing so tells Cloud Storage the gzip is a transport encoding it may strip, so downloads get decompressively transcoded and the client receives JSON where it expected a gzip stream — `gunzipSync` then throws on every scene. `unpackJSON` sniffs the gzip magic number so blobs written before this was understood still load.

### Per-user storage is not end-to-end encrypted

Collab rooms and share links are encrypted in the browser because their keys ride in the URL fragment. That does not transfer to a user account: Google sign-in yields no password to derive a key from, there is no server component to escrow one, and no Admin SDK key is available. Real E2E would require a user-held passphrase and a recovery story — a separate product.

So per-user scenes are stored compressed but unencrypted, with the security rules as the only boundary. **Whoever controls this Firebase project can read signed-in users' scenes.** That is a deliberate trade, and it is the reason `firestore.rules` scopes the permissive collab rule to `/scenes/{roomId}` rather than leaving it as a `/{document=**}` catch-all — rules are a union, and a catch-all would have silently granted the world write access to every user's workspace.

## Share links are not served from here

They are handled by the `excalidraw-scenes` service in `docker-compose.selfhost.yml`, which stores scenes on a volume next to the app.

This is worth recording, because Firebase looks like the obvious home for them and isn't. A Cloud Function serving the scene endpoints was built, deployed, and then removed: Cloud Run authorizes with IAM, so a browser-reachable endpoint needs `roles/run.invoker` granted to `allUsers`, and two policies on this organization block every route to that:

```
constraints/iam.allowedPolicyMemberDomains        allowedValues: [C039tkjev]
constraints/iam.disableServiceAccountKeyCreation  enforced: true
```

The first refuses any IAM member outside the Workspace domain, ruling out `allUsers` and also Workload Identity Federation as a keyless substitute. The second rules out putting a service-account key on the app host and proxying to a private service. Overriding either requires `roles/orgpolicy.policyAdmin`, which is grantable only at organization or folder scope — a project-scoped grant is rejected as unsupported for the resource.

A Workspace super admin could grant that role and set a project-scoped exception to the first constraint. It was deliberately not done: the exception would apply to every resource in the project, permanently, to save running one small container. If that trade ever looks worthwhile, the service in `selfhost/scenes-backend/` and a Cloud Function implement the same two-endpoint contract, so either can back the `VITE_APP_BACKEND_V2_*` build args.

## Current state

Provisioned in `excalifork-40f48`:

- Web app registered, config below
- Firestore `(default)` database in `us-central1`, rules deployed
- Cloud Storage default bucket `excalifork-40f48.firebasestorage.app` in `US-CENTRAL1`, rules deployed
- Blaze billing active — required since **3 February 2026**, when Spark-plan projects lost Cloud Storage access entirely

## Redeploying rules

```bash
firebase deploy --only storage,firestore
```

**Rules in this repo are not rules in the project.** Editing the files above changes nothing until this command runs, and the failure mode is quiet: sign-in succeeds, then every workspace read returns `permission-denied` and the app reports "This account isn't allowed to store scenes here". The `users/{uid}` matches shipped in one commit and were deployed in another, which is exactly that gap. Re-run the deploy after any change to either file.

The room and share-link paths are permissive by upstream design (`allow get, write: if true`), and nothing in them is confidential: those contents are encrypted client-side. The `users/{uid}` paths are the opposite — unencrypted, with the rules as the only boundary — so a mistake there is a real disclosure, not a nuisance. Verify per-user isolation in the rules simulator after any rules change, and keep this project single-purpose: it has no guardrail against a public bucket beyond the rules themselves.

## The app's Firebase config

Not a secret; it ships in the client bundle. Set as a build arg in Coolify:

```
VITE_APP_FIREBASE_CONFIG={"apiKey":"AIzaSyDYYtRPpo7lNM1lYnKBvJb3lix-TzQTL-w","authDomain":"excalifork-40f48.firebaseapp.com","projectId":"excalifork-40f48","storageBucket":"excalifork-40f48.firebasestorage.app","messagingSenderId":"749899688069","appId":"1:749899688069:web:fbcbcbaf9bd1b19cfd61ec"}
```

Vite inlines it at build time, so changing it needs a rebuild, not a restart. Without it, `JSON.parse` fails and the config falls back to `{}` (`excalidraw-app/data/firebase.ts:46`): live collaboration still works, but images don't sync and rooms aren't persisted after everyone leaves.
