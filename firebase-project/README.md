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

`excalidraw-app/scenes/cloudSync.ts` drives it; the merge rules it runs on are in `cloudMerge.ts`, kept pure and directly tested because they are the part that can lose a drawing. The short version: per-scene last-write-wins on `updatedAt`, deletions carried as tombstones so a delete on one device isn't undone by the next push from another, and payloads pulled lazily when a scene is opened rather than eagerly — an account can hold far more than one browser's localStorage.

No bucket CORS configuration is needed, despite what most Cloud Storage advice says. `gsutil cors set` governs `storage.googleapis.com`, the direct GCS API. The JS SDK doesn't use that host — `getBytes`, `uploadBytes` and `deleteObject` all go to `firebasestorage.googleapis.com/v0/...`, the Firebase-managed endpoint, which answers preflight from any origin with `access-control-allow-origin: *` and allows the headers the SDK sends (`Authorization`, `Range`, `Content-Type`). Verify with:

```bash
curl -sD - -o /dev/null -X OPTIONS \
  "https://firebasestorage.googleapis.com/v0/b/excalifork-40f48.firebasestorage.app/o/probe?alt=media" \
  -H "Origin: https://example.com" -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization,range" | grep -i access-control
```

This would stop being true if scenes were ever fetched by raw URL against `storage.googleapis.com` instead of through the SDK.

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

The room and share-link paths are permissive by upstream design (`allow get, write: if true`), and nothing in them is confidential: those contents are encrypted client-side. The `users/{uid}` paths are the opposite — unencrypted, with the rules as the only boundary — so a mistake there is a real disclosure, not a nuisance. Verify per-user isolation in the rules simulator after any rules change, and keep this project single-purpose: it has no guardrail against a public bucket beyond the rules themselves.

## The app's Firebase config

Not a secret; it ships in the client bundle. Set as a build arg in Coolify:

```
VITE_APP_FIREBASE_CONFIG={"apiKey":"AIzaSyDYYtRPpo7lNM1lYnKBvJb3lix-TzQTL-w","authDomain":"excalifork-40f48.firebaseapp.com","projectId":"excalifork-40f48","storageBucket":"excalifork-40f48.firebasestorage.app","messagingSenderId":"749899688069","appId":"1:749899688069:web:fbcbcbaf9bd1b19cfd61ec"}
```

Vite inlines it at build time, so changing it needs a rebuild, not a restart. Without it, `JSON.parse` fails and the config falls back to `{}` (`excalidraw-app/data/firebase.ts:46`): live collaboration still works, but images don't sync and rooms aren't persisted after everyone leaves.
