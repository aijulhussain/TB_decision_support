"""Load the cloud database (e.g. Neon) and rebuild the static dashboard with the production salt.

Reads settings from a local env file (default .env.vercel, which git ignores), never prints secrets, then runs:
    python -m tbds.cli run-all [--drop]     -> synthetic data, models, cloud database
    python -m tbds.cli export-static        -> public/app/ built with the same salt as the database

Usage:  python scripts/load_cloud.py [--env-file .env.vercel] [--keep]
        --keep  keep people's recorded work (no --drop); use once the pilot is running
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEEDED = ("TBDS__DATABASE__URL", "TBDS__SECURITY__PSEUDONYM_SALT", "TBDS_SEED_PASSWORD")


def read_env(path: Path) -> dict[str, str]:
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", default=str(ROOT / ".env.vercel"))
    ap.add_argument("--keep", action="store_true", help="do not drop existing data (keeps reviews, gap actions, audits)")
    args = ap.parse_args()
    path = Path(args.env_file)
    if not path.exists():
        print(f"missing {path}"); return 1
    env = read_env(path)
    missing = [k for k in NEEDED if not env.get(k)]
    if missing:
        print("fill these in", path.name, "first:", ", ".join(missing)); return 1
    url = env["TBDS__DATABASE__URL"]
    host = url.split("@")[-1].split("/")[0] if "@" in url else "?"
    print(f"database host: {host}  (credentials hidden)")
    if "localhost" in host or "127.0.0.1" in host:
        print("refusing: that is a local database, not the cloud one"); return 1

    run_env = os.environ.copy()
    run_env.update({k: v for k, v in env.items() if k.startswith("TBDS")})
    run_env.pop("TBDS__APP__ENV", None)          # the pipeline itself runs in development mode
    py = sys.executable
    steps = [[py, "-m", "tbds.cli", "run-all"] + ([] if args.keep else ["--drop"]), [py, "-m", "tbds.cli", "export-static"]]
    for cmd in steps:
        print("\n$", " ".join(Path(c).name if i == 0 else c for i, c in enumerate(cmd)))
        r = subprocess.run(cmd, cwd=ROOT, env=run_env)
        if r.returncode:
            print("step failed"); return r.returncode
    print("\nDone. Next: commit and push public/ so Vercel serves the matching snapshot.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
