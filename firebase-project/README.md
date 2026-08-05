# Firebase project

Backing services for a self-hosted Excalidraw.

| Piece             | Serves                                  |
| ----------------- | --------------------------------------- |
| `storage.rules`   | Images in shared links and collab rooms |
| `firestore.rules` | Collab room persistence                 |

The app reaches both through the client SDK using `VITE_APP_FIREBASE_CONFIG`. That path authorizes with the web API key and security rules, not IAM.

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

Both rule files are permissive by upstream design (`allow get, write: if true` scoped to the room and share-link paths). Nothing here is confidential: room contents are encrypted client-side. Keep this project single-purpose — it has no guardrail against a public bucket beyond the rules themselves.

## The app's Firebase config

Not a secret; it ships in the client bundle. Set as a build arg in Coolify:

```
VITE_APP_FIREBASE_CONFIG={"apiKey":"AIzaSyDYYtRPpo7lNM1lYnKBvJb3lix-TzQTL-w","authDomain":"excalifork-40f48.firebaseapp.com","projectId":"excalifork-40f48","storageBucket":"excalifork-40f48.firebasestorage.app","messagingSenderId":"749899688069","appId":"1:749899688069:web:fbcbcbaf9bd1b19cfd61ec"}
```

Vite inlines it at build time, so changing it needs a rebuild, not a restart. Without it, `JSON.parse` fails and the config falls back to `{}` (`excalidraw-app/data/firebase.ts:46`): live collaboration still works, but images don't sync and rooms aren't persisted after everyone leaves.
