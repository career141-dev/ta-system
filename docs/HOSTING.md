# Hosting the TA System on the live server

The live VPS already runs the Convex backend (`api.career141.com`), the CV app,
Qdrant, Redis and LiveKit under Docker Compose, behind a reverse proxy. The TA
System joins that Compose project as one more container on `ta.career141.com`.

Read `DEPLOYMENT-ACTIONS-2026-09-15.md` first: the credential rotation and the
two open functions in the live system are blocking, and this file assumes they
are done.

Files in this repository used below: `Dockerfile`, `docker-compose.ta.yml`,
`.env.production.example`.

---

## Why the app must sit next to the backend

The TA server calls Convex with the deployment's **admin key**, which reads and
writes anything. To stop a copy of the app being pointed at the real database by
changing one line, it refuses any backend that is not on this machine
(`src/lib/convexHost.ts`). The one exception: a deployment that sets
`C141_DEPLOYMENT=production` **and** names the host it expects in
`C141_CONVEX_HOST`. The Compose file sets both, so the app reaches the backend as
`http://backend:3210` over the private Docker network, and the backend needs no
public port of its own.

Because of this, hosting the app anywhere other than beside the backend is not
supported. Do not open port 3210 to the internet to work around it.

---

## 1 · Once, on the server

```bash
# As a user in the docker group
sudo mkdir -p /srv/ta-system && sudo chown "$USER" /srv/ta-system
git clone <this repository> /srv/ta-system
cd /srv/ta-system && git checkout claude/ta-cv-pipeline-integration-c3e27a

cp .env.production.example .env.production
chmod 600 .env.production
$EDITOR .env.production          # fill in every value; see the file's comments
```

Generate the two secrets with `openssl rand -base64 48` (one each for
`C141_SESSION_SECRET` and `C141_CRON_SECRET`), and paste the **rotated** Convex
admin key and the production Clerk keys.

DNS: an A record for `ta.career141.com` pointing at the VPS.

## 2 · Deploy the backend functions

From the CV system's folder on the server (the Convex CLI must target the local
backend, not the public URL):

```bash
cd /srv/ta-system
npx convex deploy --url http://127.0.0.1:3210 --admin-key "$CONVEX_SELF_HOSTED_ADMIN_KEY"
```

Then set the backend's own environment (Microsoft Graph and the rest) with
`npx convex env set …`, as listed in the deployment actions file, and confirm the
TA functions are closed:

```bash
curl -s -X POST http://127.0.0.1:3210/api/query \
  -H 'content-type: application/json' \
  -d '{"path":"ta/candidates:stats","args":{},"format":"json"}'
# expect: Could not find public function
```

## 3 · Start the app

```bash
cd /srv/career141            # the folder holding the CV system's docker-compose.yml
docker compose -f docker-compose.yml -f /srv/ta-system/docker-compose.ta.yml \
  up -d --build ta
docker compose logs -f ta    # until "Ready"
curl -sI http://127.0.0.1:3100/signin | head -1   # expect 200
```

## 4 · Publish it

Add one block to the reverse proxy. Caddy:

```
ta.career141.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3100
}
```

then `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` (or
`sudo systemctl reload caddy` if Caddy runs on the host). Nginx equivalent:

```nginx
server {
    server_name ta.career141.com;
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }
}
# then: sudo certbot --nginx -d ta.career141.com && sudo nginx -s reload
```

Check `https://ta.career141.com` loads the sign-in page over HTTPS.

## 5 · The nightly job

Database matching for every open job runs when something calls it. On the host:

```bash
sudo crontab -e
# 02:30 every day, Colombo time
30 2 * * * curl -fsS -X POST https://ta.career141.com/api/cron/nightly \
  -H "Authorization: Bearer <C141_CRON_SECRET>" >> /var/log/ta-nightly.log 2>&1
```

## 6 · Updating later

Once production is enabled in the pipeline, releases go through the
**Deploy Production** workflow instead (docs/CI-CD.md). The commands below are
the manual fallback.

```bash
cd /srv/ta-system && git pull
npx convex deploy --url http://127.0.0.1:3210 --admin-key "$CONVEX_SELF_HOSTED_ADMIN_KEY"   # if convex/ changed
cd /srv/career141 && docker compose -f docker-compose.yml -f /srv/ta-system/docker-compose.ta.yml up -d --build ta
```

Compose starts the new container before removing the old one only if you ask it
to; for a quiet desk, deploy outside working hours. Roll back with
`git checkout <previous commit>` and the same build command — the image is
rebuilt from source, so nothing else is needed.

## 7 · Backups and health

- **Before every deploy:** `npx convex export --url http://127.0.0.1:3210 --admin-key "$KEY" --path /backups/convex-$(date +%F).zip`
- **Container health:** `docker compose ps` shows the TA container healthy or not
  (the check fetches its own sign-in page every 30s).
- **Logs:** `docker compose logs --tail 200 ta`, rotated at 20 MB × 5 files.
- **Memory:** the container is capped at 1 GB. If it is killed repeatedly, raise
  `mem_limit` and `NODE_OPTIONS=--max-old-space-size` together.

## 8 · Running without Docker (alternative)

If you would rather run it on the host, the app talks to `http://127.0.0.1:3210`
directly and needs no host exception:

```bash
cd /srv/ta-system && npm ci && npm run build
# .env.production with CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 (no C141_CONVEX_HOST)
sudo tee /etc/systemd/system/ta-system.service >/dev/null <<'UNIT'
[Unit]
Description=Career141 TA System
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=/srv/ta-system
EnvironmentFile=/srv/ta-system/.env.production
Environment=NODE_ENV=production PORT=3100 HOSTNAME=0.0.0.0
ExecStart=/usr/bin/node .next/standalone/server.js
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable --now ta-system
```

`HOSTNAME=0.0.0.0` matters: Next's standalone server fails to reach itself when
bound only to `127.0.0.1` on a dual-stack host. After `npm run build`, copy the
static files next to the standalone server:
`cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public`.

## 9 · After it is up

Run the smoke checks in `DEPLOYMENT-ACTIONS-2026-09-15.md` §E. The end-to-end
test suite (`npm run e2e`) is for a test deployment only — it refuses to run
against production, because the functions it uses require the outbound lock.
