# Deploying AutoGenBook to the CERIT-SC Kubernetes platform

This guide maps the existing Docker Compose stack (`docker-compose.yml`) onto Kubernetes
manifests suitable for the CERIT-SC / e-infra.cz Kubernetes platform (`*.cerit-sc.cz`,
`docs.cerit.io`). It assumes you already have `kubectl` configured against the cluster
(`docs/` reference: [kubectl setup](https://docs.cerit.io/en/docs/kubernetes/kubectl)) and a
namespace assigned to you.

Sources used throughout: [Hello World example](https://docs.cerit.io/en/docs/examples/helloworld),
[NGINX case study](https://docs.cerit.io/en/docs/case-studies/nginx),
[Security](https://docs.cerit.io/en/docs/kubernetes/security),
[SecurityContext](https://docs.cerit.io/en/docs/kubernetes/securitycontext),
[Certificates](https://docs.cerit.io/en/docs/kubernetes/certificates),
[Exposing applications](https://docs.cerit.io/en/docs/kubernetes/expose),
[Harbor registry](https://docs.cerit.io/en/docs/docker/harbor),
[Docker limitations](https://docs.cerit.io/en/docs/docker/limitations).

## 0. Fill in these values before you start

| Placeholder | Meaning | Value |
|---|---|---|
| `<NAMESPACE>` (resolved) | Your cluster namespace | **`autogenbook`** (Rancher project `c-m-qvndqhf6:p-8cnwd`) |
| `<HARBOR_USER>` (resolved) | Your Harbor username (lowercase) | **`conerzyo`** |
| `<HOST>` (resolved) | Public hostname for the web UI | **`seslab-autogenbook`** (`seslab-autogenbook.dyn.cloud.e-infra.cz`) |
| `<TAG>` (resolved) | Image tag you push | **`1.0.0`** (initial release) |

All of `<NAMESPACE>`, `<HARBOR_USER>`, `<HOST>`, and `<TAG>` are now filled in with real values
throughout this guide — only `<NEW_TAG>` in step 16 (updating a running deployment) remains a
literal placeholder, since each future update is its own per-build choice.

**Rancher-managed namespace, two things to know before provisioning anything:**

- Rancher stamped this namespace with a default container `LimitRange`
  (`field.cattle.io/containerDefaultResourceLimit`: `requestsCpu: 1, requestsMemory: 512Mi,
  limitsCpu: 1, limitsMemory: 512Mi`). Every container manifest in this guide already sets its
  own `resources`, so this default won't silently apply to them — but it will to anything you
  add later without explicit `resources` (e.g. a one-off debug pod), capping it at 1 CPU /
  512Mi. Check it directly: `kubectl describe limitrange -n autogenbook`.
- `field.cattle.io/resourceQuota` shows all-zero (`requestsCpu: 0m`, `requestsMemory: 0Mi`,
  etc.). In Rancher's convention `0` on a project quota field usually means "no explicit
  ceiling set," not "zero allowed" — but don't take that on faith. Confirm before deploying:
  `kubectl describe resourcequota -n autogenbook`. If it comes back empty (no ResourceQuota
  object at all), there's no cap; if it lists one with real numbers, size the manifests in this
  guide against it.

## 1. Why the app needed code changes before it could run here (done)

CERIT-SC enforces Kubernetes **Pod Security Admission** (restricted-ish) instead of the old
PSP, and it does **not** auto-inject security settings — you must set them yourself or the
Pod is rejected outright
([SecurityContext](https://docs.cerit.io/en/docs/kubernetes/securitycontext)). The platform's
[Docker limitations](https://docs.cerit.io/en/docs/docker/limitations) page is blunt about
what this rules out: containers cannot run as root, cannot escalate privileges, must run as a
single **numeric** UID, and cannot bind ports below 1024.

**Status: applied and verified.** The repo's root `Dockerfile` (used for both `api` and
`worker`) had no `USER` directive, so it ran as root; `app/Dockerfile` was based on the
(root-running) `nginx:1.27-alpine`. Both were changed, `docker-compose.yml`'s `web` port
mapping was updated to match, and the full stack was rebuilt and smoke-tested locally
(`docker compose up --build` → all 5 containers healthy, `api`/`worker` run as UID 1000, `web`
runs as UID 101, and `/`, `/api/v1/health`, `/api/v1/ready` all return 200 through the nginx
proxy). The diffs actually applied:

```dockerfile
# ... existing apt-get / pip install layers stay as-is (they need root at build time) ...
COPY . .

RUN groupadd -g 1000 app \
    && useradd -u 1000 -g app -d /app -M app \
    && mkdir -p /app/runs /app/kb_cache \
    && chown -R app:app /app

ENV HOME=/app
USER 1000

EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

`ENV HOME=/app` matters here even though the app itself doesn't write to `$HOME`: pandoc,
LuaLaTeX and Tesseract (installed for PDF/OCR support) sometimes try to create cache/config
dirs under `$HOME` at runtime, and a non-root user can't write to the default `/root`.

`app/Dockerfile` (the nginx-based frontend image) already listens on port 80 via the stock
`nginx:1.27-alpine` base image running as root — same problem. Rather than patching it,
**switch to the same trick the CERIT NGINX case study uses**: keep the multi-stage build for
the frontend assets, but serve them from `nginxinc/nginx-unprivileged` instead of `nginx`,
which already runs as UID 101 and listens on 8080:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --config.minimum-release-age=0
COPY . .
RUN pnpm build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
```

`app/nginx.conf.template`'s `listen 80;` was changed to `listen 8080;` to match — nothing else
in that file changed (the `envsubst`-on-templates behavior, `client_max_body_size`, rate
limiting, and the `/api/` proxy block are unaffected). `docker-compose.yml`'s `web` port
mapping (`WEB_PORT:8080` → container port) was updated from `:80` to `:8080` to match, so
local Compose usage is unaffected — `WEB_PORT` (default `8080`) is still the host-side port
you browse to.

## 2. Build and push images to Harbor

Per [Harbor registry](https://docs.cerit.io/en/docs/docker/harbor): the registry lives at
`cerit.io` (web UI at `hub.cerit.io`), you can't use SSO for `docker login` — grab your **CLI
secret** from your Harbor user profile page instead. Every user gets a personal project with a
100 GB artifact quota, and **images are pullable by anyone who can guess the name** — never
bake secrets into the image.

```bash
docker login cerit.io   # username = Harbor username, password = CLI secret from your profile

# api + worker share one image (same as docker-compose.yml's `api`/`worker` both building `.`)
docker build -t cerit.io/conerzyo/autogenbook:1.0.0 .
docker push cerit.io/conerzyo/autogenbook:1.0.0

# frontend/nginx image
docker build -t cerit.io/conerzyo/autogenbook-web:1.0.0 ./app
docker push cerit.io/conerzyo/autogenbook-web:1.0.0
```

Images in your personal Harbor project are public-by-default within the cluster, so no
`imagePullSecrets` are required to pull them back down in your namespace.

## 3. Namespace context

```bash
kubectl config set-context --current --namespace=autogenbook
kubectl get resourcequota,limitrange -n autogenbook   # see what CPU/mem/storage you actually have
kubectl describe resourcequota -n autogenbook          # resolve the all-zero-vs-unlimited question from step 0
kubectl describe limitrange -n autogenbook             # confirm the 1 CPU / 512Mi Rancher default
```

The Docker limitations page doesn't publish fixed CPU/memory/storage numbers — those are
per-namespace quotas set for your project, so check them before sizing requests/limits below.

## 4. Config and secrets

Non-secret values go in a ConfigMap; anything sensitive (`OPENROUTER_API_KEY`, DB/S3
passwords) goes in a `Secret` created imperatively so it never lands in git.

```yaml
# k8s/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: autogenbook-config
data:
  POSTGRES_DB: "autogenbook"
  POSTGRES_USER: "autogenbook"
  DATABASE_URL: "postgresql+psycopg://autogenbook:$(POSTGRES_PASSWORD)@db:5432/autogenbook"
  S3_ENDPOINT_URL: "http://minio:9000"
  S3_ACCESS_KEY: "autogenbook"
  S3_BUCKET: "autogenbook"
  RUNS_DIR: "/app/runs"
  KB_EXTRACT_CACHE_DIR: "/app/kb_cache"
  MAX_UPLOAD_MB: "200"
  WORKER_CONCURRENCY: "1"
  WORKER_POLL_INTERVAL_S: "2"
  WORKER_STALE_S: "300"
  RUNS_RETENTION_DAYS: "30"
  CLI_RUN_TIMEOUT_S: "21600"
  CLI_CANCEL_GRACE_S: "15"
  AUTOGENBOOK_KB_OCR: "1"
  AUTOGENBOOK_KB_OCR_LANG: "eng"
  MCP_GATEWAY_ENABLE: "0"
  CLI_ENTRYPOINT: "run_engine.py"
  AUTOGENBOOK_LLM_BASE_URL: "https://llm.ai.e-infra.cz/v1/"
  AUTOGENBOOK_LLM_MODEL: "qwen3.8-flash-next"
  AUTOGENBOOK_LLM_MINI_MODEL: "deepseek-v4.1-flash"
  AUTOGENBOOK_LLM_REASONING_EFFORT: "none"
  AUTOGENBOOK_FORCE_MINI_MODEL: "0"
  AUTOGENBOOK_CONCURRENCY: "1"
```

`DATABASE_URL`'s `$(POSTGRES_PASSWORD)` shell-style interpolation doesn't work inside a plain
ConfigMap value — build the real DSN as a Secret field instead (below), so this ConfigMap key
is only there for reference/documentation; the Deployments will reference `DATABASE_URL` from
the Secret, not the ConfigMap.

`AUTH_JWT_SECRET` must be in this Secret too — `api/core/settings.py:Settings` refuses to boot
without one at least 32 bytes long (issue #96, same JWT-cookie auth referenced in step 12).

```bash
kubectl create secret generic autogenbook-secrets \
  --from-literal=POSTGRES_PASSWORD='<choose-a-strong-password>' \
  --from-literal=S3_SECRET_KEY='<choose-a-strong-secret>' \
  --from-literal=DATABASE_URL='postgresql+psycopg://autogenbook:<same-password-as-above>@db:5432/autogenbook' \
  --from-literal=OPENROUTER_API_KEY='<your-openrouter-key>' \
  --from-literal=TAVILY_API_KEY='<your-tavily-key-or-empty>' \
  --from-literal=AUTH_JWT_SECRET="$(openssl rand -hex 32)"
```

**Optional - per-user LLM keys.** Add `--from-literal=LLM_KEY_ENCRYPTION_KEY="$(python -c 'import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')"`
to turn on "bring your own LLM key" (each user stores their own key in Account settings; it is
Fernet-encrypted at rest with this value, and their runs then get their own per-key parallel-request
budget at the gateway, `LLM_USER_KEY_CONCURRENCY` in `k8s/configmap.yaml`). Leave it out and the
feature is disabled - everyone keeps using `OPENROUTER_API_KEY`. `LLM_KEY_POLICY` (ConfigMap,
`optional` default) set to `required` refuses runs from users without a key, and needs the
encryption key. **Back this value up**: if it is lost or changed, every stored user key becomes
undecryptable and those users' runs fail with a clear error until they re-enter their key.

**Optional - dedicated embedding/rerank key.** The e-INFRA gateway can issue a second API key that
is valid only for the embedding and reranking models and has no parallel-request limit (the main
chat key allows ~4 requests in flight). Put it in `AUTOGENBOOK_EMBED_API_KEY` and
`AUTOGENBOOK_RERANK_API_KEY` (usually both hold the same key). When either differs from the chat
key (or its `*_BASE_URL` differs from the chat base URL), the engine sends those requests outside the
chat concurrency limiter, and embeds documents and batches `AUTOGENBOOK_EMBED_CONCURRENCY` (default 8) at a
time; a per-user chat key is never used for the backend whose key is set here. Without them embeddings and
reranking use the main key (a user's own key for their runs). On a live Secret:

```bash
kubectl -n <ns> patch secret autogenbook-secrets --type merge \
  -p '{"stringData":{"AUTOGENBOOK_EMBED_API_KEY":"…","AUTOGENBOOK_RERANK_API_KEY":"…"}}'
kubectl -n <ns> rollout restart deploy/api deploy/worker
```

Both keys are in `OPTIONAL_SECRET_KEYS` in `scripts/deploy.py`, so `--sync-secrets` carries them
over from the live Secret (or writes them from the env file when set there) and
`--drop-optional-secret AUTOGENBOOK_EMBED_API_KEY` (or `..._RERANK_API_KEY`) removes one.

**Rotating any of these later**: put the same keys in a `.env.production` file at the repo root
(plain `KEY=VALUE` lines - gitignored by `/.env*` in `.gitignore`, and `scripts/deploy.py`
refuses to read it if it somehow isn't) and run `python scripts/deploy.py --stage prod --sync-secrets`
to see which keys would change, or add `--apply` to actually write them - it's idempotent, unlike
the `create` command above, and never prints any secret value, only which keys are new/changed/
unchanged. The dev stage reads `.env.dev` instead (section 18). `LLM_KEY_ENCRYPTION_KEY` is the
one optional key (`OPTIONAL_SECRET_KEYS` in `scripts/deploy.py`): existing env files without it
keep validating. If the env file sets a non-empty value it is written to the Secret; if it
doesn't, the value currently in the live Secret is **carried over unchanged** (the plan prints
`KEPT from the cluster`) - a sync never removes it by omission, since that would make every
stored user key undecryptable (or crash-loop api/worker under `LLM_KEY_POLICY=required`). To
remove it deliberately, pass `--drop-optional-secret LLM_KEY_ENCRYPTION_KEY` (the plan prints `REMOVED`).

## 5. Storage

`api` and `worker` share two volumes (`runs_data`, `kb_extract_cache`) exactly like they share
Docker named volumes today — that requires `ReadWriteMany`, which on this platform means the
`nfs-csi` storage class (per the [NGINX case study](https://docs.cerit.io/en/docs/case-studies/nginx)).
Postgres and MinIO only need `ReadWriteOnce` each.

**Status: Postgres on `nfs-csi` failed in practice and was moved to block storage.** The plain
`postgres:16-alpine` Deployment in step 6 crashlooped with `initdb: error: could not change
permissions of directory "/var/lib/postgresql/data": Operation not permitted` — `nfs-csi`'s NFS
export squashes root, so the kubelet can't `chown` the volume to `fsGroup: 999` no matter what
`securityContext` the Pod sets, and this cluster's restricted Pod Security Admission (step 1)
rules out the usual root-`initContainer`-chown workaround. This is a known NFS-CSI +
fsGroup limitation, not a manifest bug — CERIT's own
[CloudNative-PG operator page](https://docs.cerit.io/en/docs/operators/postgres-cnpg) exists
specifically because of it. `kubectl get storageclass` on this cluster shows a Ceph RBD block
class (`csi-ceph-rbd-du`), which sidesteps the problem entirely (a real block device doesn't
have NFS's root-squash behavior) and needs no change to `k8s/db.yaml` — only `postgres-data`'s
`storageClassName` below changed, from `nfs-csi` to `csi-ceph-rbd-du`. `minio-data` stays on
`nfs-csi`: MinIO's own startup doesn't hit the same chown-on-init failure, so there was no
reason to move it. If `csi-ceph-rbd-du` (or an equivalent block class) isn't available on your
cluster, switch to the CloudNative-PG operator instead — it's the platform-documented fix for
this exact issue.

Sizes below are confirmed for this deployment's actual scale: a 4-person lab generating
course-material books for two courses from up to ~100 sources total. That's a small workload —
even generously-sized PDFs across 100 sources land well under the `minio-data`/
`kb-extract-cache` sizes below, and Postgres only stores project/run metadata rows, not file
content. Grow any of these later with `kubectl edit pvc <name>` (`nfs-csi` supports online
expansion) if `kubectl get pvc` shows one filling up.

```yaml
# k8s/pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: csi-ceph-rbd-du
  resources:
    requests:
      storage: 5Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: minio-data
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: nfs-csi
  resources:
    requests:
      storage: 20Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: runs-data
spec:
  accessModes: [ReadWriteMany]
  storageClassName: nfs-csi
  resources:
    requests:
      storage: 20Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: kb-extract-cache
spec:
  accessModes: [ReadWriteMany]
  storageClassName: nfs-csi
  resources:
    requests:
      storage: 10Gi
```

Adjust sizes to your quota and expected run volume.

## 6. Postgres

The official `postgres:16-alpine` image's entrypoint script normally uses `gosu` to drop from
root to the `postgres` user (UID 999) itself; forcing `runAsNonRoot`/`runAsUser: 999` from the
Pod spec skips that step, so the mounted PVC must already be group-writable by GID 999 —
that's what `fsGroup: 999` below is for. This is a commonly-hit rough edge with restricted
Postgres pods; if the container CrashLoopBackOffs on first start with a permissions error,
check `kubectl logs` first before assuming the manifest is wrong.

**Second rough edge, hit right after the first was fixed by moving to block storage (step 5):**
a freshly provisioned block volume's filesystem creates a `lost+found` directory at its root,
and `initdb` refuses to initialize a directory that isn't completely empty —
`initdb: error: directory "/var/lib/postgresql/data" exists but is not empty`. The official
`postgres` image's own documented fix is to point `PGDATA` at a subdirectory of the mount
instead of the mount root, which is what the `env:` block below does.

```yaml
# k8s/db.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: db
spec:
  replicas: 1
  strategy:
    type: Recreate   # RWO volume - never run two Postgres pods at once
  selector:
    matchLabels: {app: db}
  template:
    metadata:
      labels: {app: db}
    spec:
      securityContext:
        fsGroupChangePolicy: OnRootMismatch
        fsGroup: 999
        runAsNonRoot: true
        seccompProfile: {type: RuntimeDefault}
      containers:
      - name: db
        image: postgres:16-alpine
        securityContext:
          runAsUser: 999
          runAsGroup: 999
          allowPrivilegeEscalation: false
          capabilities: {drop: [ALL]}
        envFrom:
        - configMapRef: {name: autogenbook-config}
        - secretRef: {name: autogenbook-secrets}
        env:
        - {name: PGDATA, value: /var/lib/postgresql/data/pgdata}
        ports:
        - containerPort: 5432
        resources:
          requests: {cpu: 250m, memory: 512Mi}
          limits: {cpu: "1", memory: 1Gi}
        volumeMounts:
        - {name: data, mountPath: /var/lib/postgresql/data}
        readinessProbe:
          exec: {command: ["pg_isready", "-U", "autogenbook", "-d", "autogenbook"]}
          periodSeconds: 5
      volumes:
      - {name: data, persistentVolumeClaim: {claimName: postgres-data}}
---
apiVersion: v1
kind: Service
metadata:
  name: db
spec:
  selector: {app: db}
  ports: [{port: 5432, targetPort: 5432}]
```

## 7. MinIO

**Decision: self-hosted plain Deployment, not the platform's
[MinIO Operator](https://docs.cerit.io/en/docs/operators/minio).** The operator is worth
knowing about, but it isn't a shared managed service you just get an endpoint for — you'd
still deploy a `Tenant` custom resource into your own namespace, on your own PVC, plus two
Secrets (root credentials, app credentials) and, in its documented example, separate Ingresses
for the S3 API and its web console. It buys you three things over a plain Deployment: built-in
distributed/HA mode (needs a minimum of 4 MinIO servers), OIDC/e-infra-SSO login to the MinIO
console, and TLS between console/API out of the box. None of that matches this deployment:
MinIO here is deliberately internal-only (`ClusterIP`, no Ingress at all — uploads/downloads
are proxied through `api`, never touched directly, same as in `docker-compose.yml`) and, at 4
lab users generating course-material books from up to ~100 sources total, a single standalone
server is nowhere near needing HA or distributed mode. The plain Deployment below also mirrors
`docker-compose.yml`'s `minio` service exactly, which keeps local dev and this cluster's setup
in lockstep. Revisit the operator if this ever needs to scale beyond one small lab (more
concurrent users, HA requirements, or wanting SSO-gated console access).

```yaml
# k8s/minio.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels: {app: minio}
  template:
    metadata:
      labels: {app: minio}
    spec:
      securityContext:
        fsGroupChangePolicy: OnRootMismatch
        fsGroup: 1000
        runAsNonRoot: true
        seccompProfile: {type: RuntimeDefault}
      containers:
      - name: minio
        image: cerit.io/conerzyo/minio:RELEASE.2024-08-29T01-40-52Z
        args: ["server", "/data", "--console-address", ":9001"]
        securityContext:
          runAsUser: 1000
          runAsGroup: 1000
          allowPrivilegeEscalation: false
          capabilities: {drop: [ALL]}
        env:
        - name: MINIO_ROOT_USER
          valueFrom: {configMapKeyRef: {name: autogenbook-config, key: S3_ACCESS_KEY}}
        - name: MINIO_ROOT_PASSWORD
          valueFrom: {secretKeyRef: {name: autogenbook-secrets, key: S3_SECRET_KEY}}
        ports: [{containerPort: 9000}, {containerPort: 9001}]
        resources:
          requests: {cpu: 100m, memory: 256Mi}
          limits: {cpu: "1", memory: 1Gi}
        volumeMounts:
        - {name: data, mountPath: /data}
        readinessProbe:
          httpGet: {path: /minio/health/live, port: 9000}
          periodSeconds: 5
      volumes:
      - {name: data, persistentVolumeClaim: {claimName: minio-data}}
---
apiVersion: v1
kind: Service
metadata:
  name: minio
spec:
  selector: {app: minio}
  ports: [{name: api, port: 9000, targetPort: 9000}, {name: console, port: 9001, targetPort: 9001}]
---
apiVersion: batch/v1
kind: Job
metadata:
  name: minio-init
spec:
  backoffLimit: 3
  template:
    metadata:
      labels: {app: minio-init}   # admitted by minio's NetworkPolicy (section 13)
    spec:
      restartPolicy: OnFailure
      securityContext:
        runAsNonRoot: true
        seccompProfile: {type: RuntimeDefault}
      containers:
      - name: mc
        image: cerit.io/conerzyo/mc:RELEASE.2024-08-17T11-33-50Z
        securityContext:
          runAsUser: 1000
          allowPrivilegeEscalation: false
          capabilities: {drop: [ALL]}
        resources:
          requests: {cpu: 50m, memory: 64Mi}
          limits: {cpu: 250m, memory: 128Mi}
        envFrom:
        - configMapRef: {name: autogenbook-config}
        - secretRef: {name: autogenbook-secrets}
        env:
        - {name: HOME, value: /tmp}
        command: ["sh", "-c"]
        args:
        - >
          mc alias set local "$S3_ENDPOINT_URL" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" &&
          mc mb --ignore-existing "local/$S3_BUCKET"
```

**Image source (September 2026, issue #141).** MinIO withdrew its `minio/minio` and `minio/mc`
repositories from Docker Hub and quay.io, so the pinned tags above can no longer be pulled from a
fresh node. The manifests therefore point at byte-identical copies of the two images that were
re-tagged from a local Docker cache and pushed to the team's Harbor project:

```bash
docker tag minio/minio:RELEASE.2024-08-29T01-40-52Z cerit.io/conerzyo/minio:RELEASE.2024-08-29T01-40-52Z
docker tag minio/mc:RELEASE.2024-08-17T11-33-50Z   cerit.io/conerzyo/mc:RELEASE.2024-08-17T11-33-50Z
docker push cerit.io/conerzyo/minio:RELEASE.2024-08-29T01-40-52Z
docker push cerit.io/conerzyo/mc:RELEASE.2024-08-17T11-33-50Z
```

Like the app images, they are pullable from inside the cluster without `imagePullSecrets` but
*not* anonymously from the internet, which is why `docker-compose.yml` (local dev and the CI e2e
job) uses the public `bitnamilegacy/minio` build of the same server instead. `scripts/deploy.py`
only rolls the `api`/`worker`/`web` Deployments, so this change reaches the cluster with a manual
`kubectl apply -f k8s/minio.yaml` (a `Recreate` rollout: MinIO is briefly unavailable while the
pod restarts on the mirrored image; the PVC data is untouched). Longer term, replacing MinIO with
a maintained S3-compatible store everywhere is tracked in issue #141.

**Status: hit and fixed.** `minio/mc` doesn't set `$HOME` for its non-root UID, so it defaults to
`/` — unwritable by UID 1000 — and `mc alias set` failed with `Unable to save new mc config.
mkdir /.mc: permission denied`. The `env: HOME=/tmp` line above is the fix (same class of issue
as the API image's `ENV HOME=/app` in step 1; `/tmp` is always world-writable, no `chown`
needed).

Run `kubectl apply -f k8s/minio-init-job.yaml` once after MinIO is `Ready`, or re-run the Job
(`kubectl delete job minio-init && kubectl apply -f ...`) any time you rotate the bucket.

The container's `resources` are explicit and small on purpose. The namespace's LimitRange
defaults a container without them to a 4-CPU limit, and once api and the five workers are
running the ResourceQuota (16 CPU of limits) has no room for that: the Job then never gets a
pod (`kubectl describe job minio-init` shows `exceeded quota`) and every `--bootstrap` re-run
times out waiting for it (October 2026 incident). The `app: minio-init` label is what the minio
NetworkPolicy (section 13) admits, for the same reason: a re-run happens with the policies in
place.

## 8. API

```yaml
# k8s/api.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 1
  selector:
    matchLabels: {app: api}
  template:
    metadata:
      labels: {app: api}
    spec:
      securityContext:
        fsGroupChangePolicy: OnRootMismatch
        fsGroup: 1000
        runAsNonRoot: true
        seccompProfile: {type: RuntimeDefault}
      containers:
      - name: api
        image: cerit.io/conerzyo/autogenbook:1.0.0
        command: ["sh", "-c", "alembic -c api/alembic.ini upgrade head && uvicorn api.main:app --host 0.0.0.0 --port 8000"]
        securityContext:
          runAsUser: 1000
          runAsGroup: 1000
          allowPrivilegeEscalation: false
          capabilities: {drop: [ALL]}
        envFrom:
        - configMapRef: {name: autogenbook-config}
        - secretRef: {name: autogenbook-secrets}
        ports: [{containerPort: 8000}]
        resources:
          requests: {cpu: 250m, memory: 512Mi}
          limits: {cpu: "1", memory: 2Gi}
        volumeMounts:
        - {name: runs, mountPath: /app/runs}
        readinessProbe:
          httpGet: {path: /api/v1/ready, port: 8000}
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet: {path: /api/v1/health, port: 8000}
          initialDelaySeconds: 10
          periodSeconds: 20
      volumes:
      - {name: runs, persistentVolumeClaim: {claimName: runs-data}}
---
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  selector: {app: api}
  ports: [{port: 8000, targetPort: 8000}]
```

Only one replica: migrations run in the container's own startup command (same as
`docker-compose.yml`), and `api` itself has no multi-instance coordination of its own
(no shared cache/session store beyond the database) - unlike `worker`, which now runs 5
replicas (see below), `api` stays single-instance.

## 9. Worker

Same image as `api`, different command — mirrors `docker-compose.yml`'s `worker` service.
`replicas: 5` with `WORKER_CONCURRENCY=1` each (issue #134 phase 3) gives 5 runs across
different projects generating in parallel while keeping each pod's crash/OOM blast radius to
one in-flight run, rather than one pod with 5 slots where a single large KB build/LuaLaTeX
pass could take all 5 down together. Housekeeping (`requeue_stale`, the stale/orphaned work-dir
sweeps) still only ever runs once per poll cycle across the whole fleet — a Postgres advisory
lock (`api/worker/__main__.py:_run_housekeeping_sweeps`) lets exactly one replica's slot 0
proceed each cycle.

```yaml
# k8s/worker.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
spec:
  replicas: 5
  selector:
    matchLabels: {app: worker}
  template:
    metadata:
      labels: {app: worker}
    spec:
      securityContext:
        fsGroupChangePolicy: OnRootMismatch
        fsGroup: 1000
        runAsNonRoot: true
        seccompProfile: {type: RuntimeDefault}
      containers:
      - name: worker
        image: cerit.io/conerzyo/autogenbook:1.0.0
        command: ["python", "-m", "api.worker"]
        securityContext:
          runAsUser: 1000
          runAsGroup: 1000
          allowPrivilegeEscalation: false
          capabilities: {drop: [ALL]}
        envFrom:
        - configMapRef: {name: autogenbook-config}
        - secretRef: {name: autogenbook-secrets}
        resources:
          requests: {cpu: 500m, memory: 1Gi}
          limits: {cpu: "2", memory: 4Gi}
        volumeMounts:
        - {name: runs, mountPath: /app/runs}
        - {name: kb-cache, mountPath: /app/kb_cache}
      volumes:
      - {name: runs, persistentVolumeClaim: {claimName: runs-data}}
      - {name: kb-cache, persistentVolumeClaim: {claimName: kb-extract-cache}}
```

LLM calls are network-bound but LaTeX/PDF compilation and OCR can spike CPU/memory — the
per-pod limits above are a starting point; watch `kubectl top pod` under real load and adjust.
At 5 replicas, size the node pool for the Deployment's aggregate footprint: 2.5 CPU / 5 Gi
requested, up to 10 CPU / 20 Gi at the limit.

## 10. Web (frontend + nginx)

```yaml
# k8s/web.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector:
    matchLabels: {app: web}
  template:
    metadata:
      labels: {app: web}
    spec:
      securityContext:
        fsGroupChangePolicy: OnRootMismatch
        fsGroup: 101
        runAsNonRoot: true
        seccompProfile: {type: RuntimeDefault}
      containers:
      - name: web
        image: cerit.io/conerzyo/autogenbook-web:1.0.0
        securityContext:
          runAsUser: 101
          runAsGroup: 101
          allowPrivilegeEscalation: false
          capabilities: {drop: [ALL]}
        env:
        - name: MAX_UPLOAD_MB
          valueFrom: {configMapKeyRef: {name: autogenbook-config, key: MAX_UPLOAD_MB}}
        ports: [{containerPort: 8080}]
        resources:
          requests: {cpu: 100m, memory: 128Mi}
          limits: {cpu: 500m, memory: 256Mi}
        readinessProbe:
          httpGet: {path: /, port: 8080}
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector: {app: web}
  ports: [{port: 80, targetPort: 8080}]
```

(Requires the `nginxinc/nginx-unprivileged` + `listen 8080` change from step 1 — `runAsUser:
101` matches that image's built-in `nginx` user, per the
[NGINX case study](https://docs.cerit.io/en/docs/case-studies/nginx).)

## 11. Ingress + TLS

Per [Exposing applications](https://docs.cerit.io/en/docs/kubernetes/expose), any
`*.dyn.cloud.e-infra.cz` hostname auto-registers and `kubernetes.io/tls-acme` +
`cert-manager.io/cluster-issuer` on the Ingress handles the certificate automatically —
no manual `Certificate` resource is needed for a plain web app like this (that page,
[Certificates](https://docs.cerit.io/en/docs/kubernetes/certificates), is for non-HTTP/non-Ingress
TLS termination, which doesn't apply here).

```yaml
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  annotations:
    kubernetes.io/tls-acme: "true"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  ingressClassName: nginx
  tls:
  - hosts: ["seslab-autogenbook.dyn.cloud.e-infra.cz"]
    secretName: seslab-autogenbook-dyn-cloud-e-infra-cz-tls
  rules:
  - host: "seslab-autogenbook.dyn.cloud.e-infra.cz"
    http:
      paths:
      - path: /
        pathType: ImplementationSpecific
        backend:
          service: {name: web, port: {number: 80}}
```

Only `web` gets an Ingress — `api`, `db`, `minio` stay `ClusterIP`-only, matching
`docker-compose.yml`'s split between the one host-published container and everything else on
internal-only networks.

## 12. Application auth (in place) and optional Ingress-level hardening

**Status: application-level auth shipped (issue #96, PR #99 `feature/auth-jwt-cookie`) after
this guide was first written — the claim below that the app has no auth is outdated.**
`docs/OPERATIONS.md`'s **Authentication and user management** section is the current source of
truth: every `/api/v1` route requires a login session (an httpOnly, `SameSite=Lax` JWT cookie)
except `POST /auth/login` and the health/ready probes, and the frontend gates on it too. That
means `k8s/ingress.yaml` is safe to `kubectl apply` as-is — it does **not** need one of the
options below before applying.

What auth does *not* cover, per the same `docs/OPERATIONS.md` section: there's still no CORS
middleware and no per-owner visibility filtering (any logged-in account can see every
project) — auth exists because CERIT-SC requires it, not to segregate the lab's own accounts
from each other. If you want defense-in-depth beyond the app's own login (e.g. keeping the
Ingress unreachable to anyone without a second factor, or restricting to a known network),
add one of these Ingress-level options on top:

- **Basic auth** (simplest, works today):
  ```bash
  htpasswd -nb <user> '<password>' | base64 -w0   # put the output in a Secret's `auth` key
  ```
  ```yaml
  apiVersion: v1
  kind: Secret
  metadata: {name: web-basic-auth}
  type: Opaque
  data: {auth: <base64-output-above>}
  ```
  then add to the Ingress:
  ```yaml
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: web-basic-auth
    nginx.ingress.kubernetes.io/auth-realm: "AutoGenBook"
  ```
- **e-infra SSO (BETA)** — per [Security](https://docs.cerit.io/en/docs/kubernetes/security),
  restricts access by email via annotations on the same Ingress; ask CERIT support for the
  exact annotation set if you want this instead of basic auth.
- **IP allowlist**, if you only need this reachable from a known network (e.g. MUNI):
  ```yaml
  annotations:
    nginx.ingress.kubernetes.io/whitelist-source-range: 147.251.0.0/16
  ```

Also note the same [Security](https://docs.cerit.io/en/docs/kubernetes/security) page's
warning: **Ingress auth doesn't protect the underlying Service** — any other pod in the shared
cluster that knows (or guesses) your namespace and Service name can still hit `api`, `db`, or
`minio` directly, bypassing whatever you put on the Ingress. Step 13 closes that gap.

## 13. NetworkPolicies (required on a shared cluster, not optional hardening)

Because `api` has zero internal auth, restricting *who inside the cluster* can reach it
matters as much as the Ingress auth above.

```yaml
# k8s/networkpolicy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: web-allow-ingress-controller-only
spec:
  podSelector: {matchLabels: {app: web}}
  policyTypes: [Ingress]
  ingress:
  - from:
    - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-allow-web-and-worker-only
spec:
  podSelector: {matchLabels: {app: api}}
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector: {matchLabels: {app: web}}
    - podSelector: {matchLabels: {app: worker}}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-allow-api-and-worker-only
spec:
  podSelector: {matchLabels: {app: db}}
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector: {matchLabels: {app: api}}
    - podSelector: {matchLabels: {app: worker}}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: minio-allow-api-and-worker-only
spec:
  podSelector: {matchLabels: {app: minio}}
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector: {matchLabels: {app: api}}
    - podSelector: {matchLabels: {app: worker}}
    - podSelector: {matchLabels: {app: minio-init}}   # the bucket-creating Job (section 7)
```

`api` itself doesn't strictly need to reach `db`/`minio` if it only ever proxies through
`worker` — but it does (project CRUD, storage healthcheck), so both are allowed above,
matching `docker-compose.yml`'s `frontend`/`backend` network split (`web`↔`api` on
`frontend`; `api`/`worker`↔`db`/`minio` on the internal-only `backend`).

## 14. Deploy order

`python scripts/deploy.py --stage <stage> --bootstrap --apply` does all of this, in this order,
for a stage (section 18) - the commands below are what it runs, for reference.

```bash
kubectl apply -f k8s/configmap.yaml
kubectl create secret generic autogenbook-secrets --from-literal=...   # from step 4, if not already applied
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/networkpolicy.yaml   # first: selects pods by label, and minio-init needs it
kubectl apply -f k8s/db.yaml -f k8s/minio.yaml
kubectl wait --for=condition=ready pod -l app=db --timeout=120s
kubectl wait --for=condition=ready pod -l app=minio --timeout=120s
kubectl apply -f k8s/minio-init-job.yaml
kubectl wait --for=condition=complete job/minio-init --timeout=60s
kubectl apply -f k8s/api.yaml -f k8s/worker.yaml -f k8s/web.yaml
kubectl apply -f k8s/ingress.yaml   # safe as-is - see step 12 on app-level auth
```

## 15. Verify

```bash
kubectl get pods,svc,ingress -n autogenbook
kubectl logs deploy/api
kubectl logs deploy/worker
curl -u <user>:<password> https://seslab-autogenbook.dyn.cloud.e-infra.cz/api/v1/health
```

Allow ~1 minute for DNS propagation on the `dyn.cloud.e-infra.cz` name and for the
Let's-Encrypt certificate to issue (`kubectl describe certificate` / `kubectl describe ingress
web` if it hangs).

## 16. Updating a running deployment

**Use `scripts/deploy.py` for this** (day-to-day redeploys after the one-time setup above) rather
than doing it by hand. It figures out which of the two images (`autogenbook` for api+worker,
`autogenbook-web` for web) actually needs rebuilding by diffing the relevant source paths against
whatever commit is *currently live* on the cluster (read back from `kubectl`, not a local
file), tags images by git commit SHA instead of a hand-picked version number, and automatically
rolls every Deployment it touched back to its previous state if any rollout fails - so the
cluster never ends up with an api/web pair that were never meant to run together.

Every run targets one stage (section 18): normally a commit goes to `--stage dev` first and
reaches prod by promotion (`--stage prod --promote`), not by a build of its own.

```bash
# Show what would be deployed, without touching anything (the default - always safe to run):
python scripts/deploy.py --stage dev

# Actually build/push/apply it, with a confirmation prompt:
python scripts/deploy.py --stage dev --apply

# Roll out on prod exactly what dev runs (no rebuild) - plan first, then for real:
python scripts/deploy.py --stage prod --promote
python scripts/deploy.py --stage prod --promote --apply

# Sync .env.production's values into prod's autogenbook-secrets Secret (see step 4) - also
# dry-run by default, and never prints secret values:
python scripts/deploy.py --stage prod --sync-secrets --apply
```

Run `python scripts/deploy.py --help` for every flag (`--force {core,web,all}` to rebuild
regardless of the diff, `--no-rollback` to leave a broken rollout in place for debugging,
`-y`/`--yes` to skip the confirmation prompt for scripting).

**How the script handles a rollout that does not finish** - shaped by a real incident where a
merely slow worker rollout tripped the timeout, the script "rolled back" `api` onto an image two
Alembic migrations behind the database, and the API crash-looped until it was re-applied by hand:

- **Broken vs slow.** `kubectl rollout status` is polled in 30 s slices and the new ReplicaSet's
  pods are inspected in between. A crash loop, an unpullable image, or a pod that has restarted
  twice is reported as *broken* within one slice and rolled back straight away. A rollout whose
  timeout elapses while every new pod still looks healthy is reported as *slow* and left running
  - the script exits 1 and tells you to wait and re-run `--apply`, which then carries on with
  whatever it had not applied yet. `--rollout-timeout` (api/web, default 180 s) and
  `--worker-rollout-timeout` (default 900 s: the worker's five replicas roll one at a time with
  `maxSurge: 0` and take about two minutes each) only bound the *healthy* case.
- **Migrations are forward-only.** `api`'s entrypoint runs `alembic upgrade head` on every start,
  so once a deploy that changes `api/infrastructure/db/alembic/versions/` has applied `api`, the
  database is at HEAD's revision and any older core image would fail with
  `Can't locate revision identified by '...'`. The plan says so up front (a `note:` line), and on
  a later failure in that run `api` and `worker` are deliberately **not** rolled back - only the
  other touched Deployments are - with instructions printed for the two possible situations
  (`api`'s new pod died before the migration ran, so `kubectl rollout undo deployment/api` is
  safe; or it ran, so fix forward). Kubernetes keeps the previous `api` ReplicaSet serving until a
  new pod is ready, so this by itself is not an outage.
- **Rollback restores what the cluster was actually running.** The pre-run baseline is the
  manifest as committed at the live tag's commit (so a bad resource-limit change bundled in HEAD
  is undone too) with its image line pinned to the tag `kubectl` reported, because that commit's
  own image line still names the deploy *before* it (the tag only lands in the follow-up
  `Deploy <tag>` commit).

The equivalent by hand, for reference or if the script itself is unavailable:

```bash
docker build -t cerit.io/conerzyo/autogenbook:<NEW_TAG> .
docker push cerit.io/conerzyo/autogenbook:<NEW_TAG>
kubectl set image deployment/api api=cerit.io/conerzyo/autogenbook:<NEW_TAG>
kubectl set image deployment/worker worker=cerit.io/conerzyo/autogenbook:<NEW_TAG>
```

Rebuild/push `autogenbook-web` the same way and `kubectl set image deployment/web ...` when
the frontend changes.

## 17. Open items / what's still needed

- **Auth mechanism (step 12)** — resolved: application-level JWT-cookie auth (issue #96)
  shipped after this guide was written, so the Ingress from step 11 no longer needs one of
  basic auth / e-infra SSO / IP allowlist before applying. Those remain available as optional
  extra hardening on top of the app's own login.
- **Namespace resource quota is currently zero** (`kubectl describe resourcequota -n
  autogenbook` → `Hard: 0` on `limits.cpu`/`limits.memory`/`requests.cpu`/`requests.memory`).
  This is a real, binding cap — not the "0 means unlimited" Rancher convention hoped for in
  step 0 — and it blocks every manifest here from scheduling at all. Raise it (self-service via
  Rancher project `p-8cnwd`'s Resource Quotas settings if you have owner access, otherwise a
  CERIT support request) before applying anything below. A reasonable ask given what this
  stack actually requests in total: `requests.cpu: 4`, `requests.memory: 8Gi`, `limits.cpu: 8`,
  `limits.memory: 16Gi`.
- Namespace, Harbor username, hostname, and image tag are resolved (`autogenbook` / `conerzyo` /
  `seslab-autogenbook.dyn.cloud.e-infra.cz` / `1.0.0`) and committed as real files under `k8s/` —
  `kubectl apply -f k8s/<file>.yaml` per the deploy order in step 14, `k8s/ingress.yaml`
  included (see its header comment for why it's safe to apply as-is).

## 18. Stages: dev (beta) and prod

There are two complete, independent copies of the stack, one per namespace: **prod**
(`autogenbook`, https://seslab-autogenbook.dyn.cloud.e-infra.cz), what users use, and **dev**
(`autogenbook-dev`, https://seslab-autogenbook-dev.dyn.cloud.e-infra.cz), where a new version is
tried out first. Each has its own Postgres, MinIO bucket, volumes, Secret, Ingress and user
accounts, so nothing done on dev can touch prod's data. They have to be separate namespaces rather
than differently named objects in one: every manifest, NetworkPolicy and in-cluster host name
(`db`, `minio`, `api`) is written against "the stack in this namespace".

### Releases and promotion

What is shared is the images: both stages pull the same `autogenbook:<sha>` / `autogenbook-web:<sha>`
tags from Harbor. A **release** is the vector {core image tag, web image tag, the commit they and
the manifests come from}; after every successful apply `deploy.py` records that commit on the
stage's Deployments as the `autogenbook.io/release-commit` annotation. Releases move forward like
this:

1. **Try a branch on dev** - any commit, from any branch: `deploy.py --stage dev --apply` builds
   whatever changed since dev's release and rolls it out. Dev's manifests are rendered into temp
   files, so this never leaves anything to commit.
2. **Merge, then deploy `main` to dev.** PRs are squash-merged, so the commits dev ran never become
   part of `main`: once the PR is in, `deploy.py --stage dev --apply` from an up-to-date `main`
   makes dev run the release candidate itself. An image is only rebuilt if its sources on `main`
   differ from what dev runs - often neither does, and then the very images you tried are what
   gets promoted. Check it on the dev URL.
3. **Promote to prod** from that same checkout of `main`:
   `deploy.py --stage prod --promote` shows the plan, `--apply` carries it out. Nothing is built:
   prod gets dev's image tags. The script then asks you to commit the retagged `k8s/*.yaml`
   ("Promote dev release <sha> to prod") and push - k8s/ keeps recording what prod runs, as before.

A promotion is refused unless:

- dev is healthy: api, worker and web completely rolled out, every replica available, and api and
  worker on the same image;
- dev's images match its release commit (dev's last deploy finished - a rollout that was slow
  finishes by re-running the same `--stage dev --apply`, which then records the release);
- the release commit is on the checked-out branch - prod only gets releases that are part of
  `main` (merge first, then promote), even though dev can run a feature branch;
- the release contains the commits prod runs now, so a promotion can never take prod backwards,
  e.g. past a fix deployed straight to prod;
- `k8s/api.yaml`, `k8s/worker.yaml` and `k8s/web.yaml` on disk, which is what gets applied, are
  the release's own (image tags aside) - otherwise deploy HEAD to dev first, so it is tested
  with them.

The rollback, slow-rollout and migration rules of section 16 apply to a promotion unchanged; the
Alembic migrations it counts are those between prod's core image and dev's.

`deploy.py --stage prod --apply` still builds HEAD straight into prod, for emergencies. Deploy a
commit containing that fix to dev afterwards - the "never backwards" rule refuses the next
promotion until dev has it.

### Stage files

`k8s/stages/<stage>.toml` holds everything that differs between the stages; the manifests in
`k8s/` are shared.

| key | meaning |
| --- | --- |
| `namespace` | the stage's namespace |
| `host` | its Ingress host; the TLS Secret is named after it (`<host with dots as dashes>-tls`) |
| `env_file` | the gitignored file `--sync-secrets` reads (`.env.production`, `.env.dev`) |
| `base = true` | prod only: `k8s/*.yaml` are its manifests exactly as they are, and deploys write image tags into them |
| `promote_from` | the stage `--promote` takes its release from (prod: `dev`) |
| `[replicas]` | replica counts that differ from `k8s/<name>.yaml` (dev: 2 workers instead of 5) |
| `[config]` | ConfigMap entries added to or overriding `k8s/configmap.yaml` (dev: its own `AUTOGENBOOK_LLM_MODEL`, `AUTOGENBOOK_CONCURRENCY`, ...) |

`[config]` and `k8s/configmap.yaml` reach a stage with `--bootstrap`, which applies the
ConfigMap and restarts api and worker if it changed; a plain deploy only notes that the live
ConfigMap differs. A promotion moves images, not config - its plan says when dev's config
differs from prod's. `deploy.py` also refuses any deploy or promotion whose core image would not
contain the stage's `CLI_ENTRYPOINT` (`run_engine.py` in `k8s/configmap.yaml` for both stages
since October 2026 - the rewritten engine), so neither stage can run a commit from before the
engine rewrite.

Resources: with dev's two workers the dev stack is 7.5 CPU / 12.25 GiB at its limits, peaking at
8.5 CPU / 14.25 GiB while api rolls out (`maxSurge`); prod with five workers is 13.5 CPU /
24.25 GiB, peaking at 14.5 CPU / 26.25 GiB. Size each namespace's ResourceQuota for its own
stage.

### Setting up dev (once)

1. Create `.env.dev` at the repo root with the same keys as `.env.production` (step 4) but dev's
   own values: a new `POSTGRES_PASSWORD`, `S3_SECRET_KEY` and `AUTH_JWT_SECRET`, and a
   `DATABASE_URL` using that password (the host stays `db` - it resolves inside dev's own
   namespace). The API keys may be shared with prod or separate.
2. `python scripts/deploy.py --stage dev --sync-secrets --apply` creates dev's Secret.
3. Check out a commit that has `run_engine.py`, then run
   `python scripts/deploy.py --stage dev --bootstrap` to review the plan, and the same with
   `--apply` to carry it out. It applies the ConfigMap, volumes, Postgres and MinIO, creates the
   bucket, builds and rolls out api/worker/web, and then applies the network policies and the
   Ingress (the certificate takes a minute to issue).
4. Create an account, since dev has its own database:
   `kubectl exec -n autogenbook-dev deploy/api -- python -m api.scripts.users create --email you@example.com --name "Your Name"`.

Dev's database is forward-only like prod's (section 16): after deploying a branch that adds an
Alembic migration, dev can't go back to a commit without it; deploy a commit that contains it.
