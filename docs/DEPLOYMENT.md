# Deployment

How to run the system for real users. For a local demo, the README's quick start is enough.

## 1. Architecture

```
browser ──HTTPS──▶ reverse proxy (Caddy / nginx, TLS) ──▶ uvicorn: tbds.api.main:app ──▶ PostgreSQL
                                                         (serves the API and the dashboard at /app/)
pipeline (cron / scheduled task): python -m tbds.cli run-all ──▶ PostgreSQL + dashboard snapshot
```

## 2. Production settings

Set these as environment variables (e.g. in a systemd unit or a secrets manager), never in `config/default.yaml`:

| Variable | Value |
|---|---|
| `TBDS__APP__ENV` | `production` |
| `TBDS__APP__CORS_ORIGINS` | `["https://tbds.example.gov.in"]`, the exact dashboard origin |
| `TBDS__SECURITY__JWT_SECRET` | random, 32+ characters, e.g. `python -c "import secrets;print(secrets.token_urlsafe(48))"` |
| `TBDS__SECURITY__PSEUDONYM_SALT` | held by NHM Assam (see `docs/DATA_ACCESS.md`) |
| `TBDS__DATABASE__URL` | `postgresql+psycopg://tbds:<strong password>@db-host:5432/tbds` |
| `TBDS_SEED_PASSWORD` | only if demo accounts are seeded at all; better, create real accounts |

With `TBDS__APP__ENV=production`, the API **refuses to start** and lists what is wrong if the JWT secret is short or
default, the salt is default, the database uses the development password, CORS allows `*`, or the demo accounts still
accept the shared demo password.

## 3. Database

```bash
python -m tbds.cli migrate        # create or upgrade the schema, keeping existing data
```

Schema changes are Alembic migrations in `tbds/db/migrations/versions/`. To add one after editing `tbds/db/schema.py`:

```bash
python - <<'EOF'
from alembic import command
from tbds.db import schema as S
command.revision(S.alembic_config(S.get_engine()), message="describe the change", autogenerate=True)
EOF
```

Review the generated file before committing. `run-all` without `--drop` keeps people's work (reviews, gap actions,
death audits, decisions, the audit log); `--drop` deletes everything.

Back up with `pg_dump` nightly and test a restore before the pilot starts.

## 4. API server

```bash
uvicorn tbds.api.main:app --host 127.0.0.1 --port 8000 --workers 2 --proxy-headers
```

Bind to `127.0.0.1` and let the proxy face the network. Sign-in lockout is per process; with several workers, add a
rate limit on `/auth/token` at the proxy too (below).

## 5. HTTPS reverse proxy

**Caddy** (obtains and renews certificates automatically), `/etc/caddy/Caddyfile`:

```
tbds.example.gov.in {
    encode gzip
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"
    reverse_proxy 127.0.0.1:8000
}
```

**nginx** equivalent, with a sign-in rate limit:

```nginx
limit_req_zone $binary_remote_addr zone=login:10m rate=10r/m;
server {
    listen 443 ssl http2;
    server_name tbds.example.gov.in;
    ssl_certificate     /etc/ssl/tbds/fullchain.pem;
    ssl_certificate_key /etc/ssl/tbds/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    location = /auth/token { limit_req zone=login burst=5; proxy_pass http://127.0.0.1:8000; }
    location / { proxy_pass http://127.0.0.1:8000; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Host $host; }
}
server { listen 80; server_name tbds.example.gov.in; return 301 https://$host$request_uri; }
```

## 6. Scheduling the pipeline

Run once per reporting cycle (e.g. weekly), after the new extract arrives:

```cron
0 2 * * 1  cd /srv/tbds/app && . .venv/bin/activate && python -m tbds.cli run-all >> /var/log/tbds/pipeline.log 2>&1
```

Check the model cards' **Monitoring by month** section after each run; a flagged month means recalibration is due.

## 7. Offline dashboard and installation

Served at `https://<host>/app/`, the dashboard registers a service worker so it opens without a connection (snapshot
data) and can be installed as an app from the browser menu. The worker caches the page only; API calls always go to the
server.

## 8. Checklist before go-live

- [ ] Production variables set; the API starts with `TBDS__APP__ENV=production`
- [ ] HTTPS with a valid certificate; HTTP redirects to HTTPS
- [ ] Demo accounts removed; named accounts created for each role
- [ ] Nightly backups and a tested restore
- [ ] Models re-validated on pilot-district retrospective data (`docs/DATA_ACCESS.md`, section 7)
- [ ] CI green on the deployed commit
