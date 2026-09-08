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
| `<TAG>` | Image tag you push (e.g. a git short SHA) | your choice, still open |

All of `<NAMESPACE>`, `<HARBOR_USER>`, and `<HOST>` are now filled in with real values
throughout this guide — only `<TAG>`/`<NEW_TAG>` remain as literal placeholders, since that's
a per-build choice rather than a fixed value.

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
docker build -t cerit.io/conerzyo/autogenbook:<TAG> .
docker push cerit.io/conerzyo/autogenbook:<TAG>

# frontend/nginx image
docker build -t cerit.io/conerzyo/autogenbook-web:<TAG> ./app
docker push cerit.io/conerzyo/autogenbook-web:<TAG>
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
```

`DATABASE_URL`'s `$(POSTGRES_PASSWORD)` shell-style interpolation doesn't work inside a plain
ConfigMap value — build the real DSN as a Secret field instead (below), so this ConfigMap key
is only there for reference/documentation; the Deployments will reference `DATABASE_URL` from
the Secret, not the ConfigMap.

```bash
kubectl create secret generic autogenbook-secrets \
  --from-literal=POSTGRES_PASSWORD='<choose-a-strong-password>' \
  --from-literal=S3_SECRET_KEY='<choose-a-strong-secret>' \
  --from-literal=DATABASE_URL='postgresql+psycopg://autogenbook:<same-password-as-above>@db:5432/autogenbook' \
  --from-literal=OPENROUTER_API_KEY='<your-openrouter-key>' \
  --from-literal=TAVILY_API_KEY='<your-tavily-key-or-empty>'
```

## 5. Storage

`api` and `worker` share two volumes (`runs_data`, `kb_extract_cache`) exactly like they share
Docker named volumes today — that requires `ReadWriteMany`, which on this platform means the
`nfs-csi` storage class (per the [NGINX case study](https://docs.cerit.io/en/docs/case-studies/nginx)).
Postgres and MinIO only need `ReadWriteOnce` each; `nfs-csi` also supports RWO, but if
`kubectl get storageclass` shows a block-storage class on your cluster, prefer that for
Postgres — Postgres on NFS works but is more sensitive to latency/locking behavior than a
block volume.

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
  storageClassName: nfs-csi
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
        image: minio/minio:RELEASE.2024-08-29T01-40-52Z
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
    spec:
      restartPolicy: OnFailure
      securityContext:
        runAsNonRoot: true
        seccompProfile: {type: RuntimeDefault}
      containers:
      - name: mc
        image: minio/mc:RELEASE.2024-08-17T11-33-50Z
        securityContext:
          runAsUser: 1000
          allowPrivilegeEscalation: false
          capabilities: {drop: [ALL]}
        envFrom:
        - configMapRef: {name: autogenbook-config}
        - secretRef: {name: autogenbook-secrets}
        command: ["sh", "-c"]
        args:
        - >
          mc alias set local "$S3_ENDPOINT_URL" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" &&
          mc mb --ignore-existing "local/$S3_BUCKET"
```

Run `kubectl apply -f k8s/minio-init-job.yaml` once after MinIO is `Ready`, or re-run the Job
(`kubectl delete job minio-init && kubectl apply -f ...`) any time you rotate the bucket.

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
        image: cerit.io/conerzyo/autogenbook:<TAG>
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
`docker-compose.yml`), and `api`/`worker`'s in-repo assumptions are single-process
(`docs/OPERATIONS.md`'s "Scaling guidance").

## 9. Worker

Same image as `api`, different command — mirrors `docker-compose.yml`'s `worker` service.

```yaml
# k8s/worker.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
spec:
  replicas: 1
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
        image: cerit.io/conerzyo/autogenbook:<TAG>
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
limits above are a starting point; watch `kubectl top pod` under real load and adjust.

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
        image: cerit.io/conerzyo/autogenbook-web:<TAG>
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

## 12. Critical: this app has no built-in authentication — you must add some

`docs/OPERATIONS.md` documents (issue #50) that `/api/v1` has **no authentication and no
per-client quota**: anyone who can reach it can read/write every project, upload files, and
kick off runs that spend your `OPENROUTER_API_KEY` budget. In Docker Compose that's mitigated
by binding to `127.0.0.1` — on a public Ingress, that protection is simply gone. Do **not**
apply the Ingress from step 11 without one of these:

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
```

`api` itself doesn't strictly need to reach `db`/`minio` if it only ever proxies through
`worker` — but it does (project CRUD, storage healthcheck), so both are allowed above,
matching `docker-compose.yml`'s `frontend`/`backend` network split (`web`↔`api` on
`frontend`; `api`/`worker`↔`db`/`minio` on the internal-only `backend`).

## 14. Deploy order

```bash
kubectl apply -f k8s/configmap.yaml
kubectl create secret generic autogenbook-secrets --from-literal=...   # from step 4, if not already applied
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/db.yaml -f k8s/minio.yaml
kubectl wait --for=condition=ready pod -l app=db --timeout=120s
kubectl wait --for=condition=ready pod -l app=minio --timeout=120s
kubectl apply -f k8s/minio-init-job.yaml
kubectl wait --for=condition=complete job/minio-init --timeout=60s
kubectl apply -f k8s/api.yaml -f k8s/worker.yaml -f k8s/web.yaml
kubectl apply -f k8s/networkpolicy.yaml
kubectl apply -f k8s/ingress.yaml   # only after step 12's auth annotation is in place
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

```bash
docker build -t cerit.io/conerzyo/autogenbook:<NEW_TAG> .
docker push cerit.io/conerzyo/autogenbook:<NEW_TAG>
kubectl set image deployment/api api=cerit.io/conerzyo/autogenbook:<NEW_TAG>
kubectl set image deployment/worker worker=cerit.io/conerzyo/autogenbook:<NEW_TAG>
```

Rebuild/push `autogenbook-web` the same way and `kubectl set image deployment/web ...` when
the frontend changes.

## 17. Open items / what's still needed

- **Auth mechanism (step 12)** — deliberately deferred. Do not apply the Ingress from step 11
  until one of basic auth / e-infra SSO / IP allowlist is decided and wired in; without it the
  app is fully unauthenticated and reachable from the public internet.
- **Namespace resource quota is currently zero** (`kubectl describe resourcequota -n
  autogenbook` → `Hard: 0` on `limits.cpu`/`limits.memory`/`requests.cpu`/`requests.memory`).
  This is a real, binding cap — not the "0 means unlimited" Rancher convention hoped for in
  step 0 — and it blocks every manifest here from scheduling at all. Raise it (self-service via
  Rancher project `p-8cnwd`'s Resource Quotas settings if you have owner access, otherwise a
  CERIT support request) before applying anything below. A reasonable ask given what this
  stack actually requests in total: `requests.cpu: 4`, `requests.memory: 8Gi`, `limits.cpu: 8`,
  `limits.memory: 16Gi`.
- Namespace, Harbor username, and hostname are resolved (`autogenbook` / `conerzyo` /
  `seslab-autogenbook.dyn.cloud.e-infra.cz`) and committed as real files under `k8s/` —
  `kubectl apply -f k8s/<file>.yaml` per the deploy order in step 14 (`k8s/ingress.yaml` is
  deliberately excluded from that pattern; see its header comment).
- `<TAG>` for the images you push — your choice (e.g. a git short SHA); find/replace it in
  `k8s/api.yaml`, `k8s/worker.yaml`, `k8s/web.yaml` once decided.
