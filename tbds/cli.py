"""Command line: python -m tbds.cli <command>

  run-all            generate/ingest -> models -> PostgreSQL -> dashboard JSON  (the whole pipeline)
  init-db            create or upgrade the database schema (--drop deletes everything first)
  migrate            upgrade an existing database to the latest schema, keeping its data
  validate           multi-seed validation of facility shrinkage (synthetic data)
  export-dashboard   rerun the pipeline and write the dashboard data file and page
  build-dashboard    rebuild dashboard/index.html from the existing data file (no pipeline run)
  export-static      write the dashboard as a static site into public/app/ (for Vercel and other static hosts)
  refit-linkage      refit duplicate-matching weights from reviewers' confirm/reject decisions
  serve              start the API (uvicorn)
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from tbds.config import ROOT


def cmd_run_all(args):
    from tbds.db import load, schema
    from tbds.pipeline.run import run_all
    R = run_all()
    eng = schema.get_engine()
    print("schema:", schema.migrate(eng, drop=args.drop))
    counts = load.persist(eng, R)
    print("persisted:", counts)
    _print_logins(R)
    if not args.no_dashboard:
        from tbds.reports.dashboard_data import build
        from tbds.reports.build_page import build_page
        out = build(R, Path(args.out))
        print("dashboard data:", out, f"({out.stat().st_size / 1e6:.2f} MB)")
        print("dashboard page:", build_page(out))
    print(f"done in {R['elapsed']:.0f}s (pipeline) ")


def _print_logins(R):
    import os
    from tbds.config import get_settings
    pilot = get_settings().pilot.districts
    custom = "TBDS_SEED_PASSWORD" in os.environ
    fac = R["ds"].facilities
    one = fac[fac.district.isin(pilot)].facility_id.iloc[0].lower() if fac.district.isin(pilot).any() else "<facility>"
    print()
    print("Demo sign-in accounts" + (" (password from TBDS_SEED_PASSWORD)" if custom else " (password: ChangeMe!2026)"))
    print("  state_admin, data_manager")
    print("  dto_<district>       e.g. " + ", ".join("dto_" + d.lower().replace(" ", "_") for d in pilot))
    print(f"  tu_<facility>        e.g. tu_{one}   (pilot districts only)")
    print(f"  field_<facility>     e.g. field_{one}")
    print()


def cmd_init_db(args):
    from tbds.db import schema
    print("schema at revision", schema.migrate(schema.get_engine(), drop=args.drop))


def cmd_migrate(args):
    from tbds.db import schema
    print("schema at revision", schema.migrate(schema.get_engine(), drop=False))


def cmd_validate(args):
    from tbds.synth.validation import shrinkage_multiseed
    print(json.dumps(shrinkage_multiseed(range(1, args.seeds + 1)), indent=2))


def cmd_export(args):
    from tbds.pipeline.run import run_all
    from tbds.reports.dashboard_data import build
    from tbds.reports.build_page import build_page
    out = build(run_all(), Path(args.out))
    print("wrote", out)
    print("wrote", build_page(out))


def cmd_build_page(args):
    from tbds.reports.build_page import build_page
    print("wrote", build_page(Path(args.data)))


def cmd_export_static(args):
    import shutil
    from tbds.reports.build_page import DASH, build_page
    out = Path(args.out) / "app"
    out.mkdir(parents=True, exist_ok=True)
    build_page(Path(args.data), out / "index.html")
    for f in ("sw.js", "manifest.webmanifest", "icon.svg"):
        shutil.copy2(DASH / f, out / f)
    size = sum(f.stat().st_size for f in out.iterdir()) / 1e6
    print(f"static site written to {out} ({size:.2f} MB). Commit public/ and push to redeploy.")


def cmd_refit(args):
    from tbds.models.linkage_refit import refit_from_reviews
    print(json.dumps(refit_from_reviews(), indent=2))


def cmd_serve(args):
    import uvicorn
    print(f"dashboard: http://localhost:{args.port}/app   API docs: http://localhost:{args.port}/docs")
    uvicorn.run("tbds.api.main:app", host=args.host, port=args.port, reload=False)


def main():
    ap = argparse.ArgumentParser(prog="tbds")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("run-all"); a.add_argument("--drop", action="store_true"); a.add_argument("--no-dashboard", action="store_true")
    a.add_argument("--out", default=str(ROOT / "dashboard" / "dashboard_data.json")); a.set_defaults(fn=cmd_run_all)
    a = sub.add_parser("init-db"); a.add_argument("--drop", action="store_true"); a.set_defaults(fn=cmd_init_db)
    a = sub.add_parser("migrate"); a.set_defaults(fn=cmd_migrate)
    a = sub.add_parser("validate"); a.add_argument("--seeds", type=int, default=12); a.set_defaults(fn=cmd_validate)
    a = sub.add_parser("export-dashboard"); a.add_argument("--out", default=str(ROOT / "dashboard" / "dashboard_data.json")); a.set_defaults(fn=cmd_export)
    a = sub.add_parser("build-dashboard"); a.add_argument("--data", default=str(ROOT / "dashboard" / "dashboard_data.json")); a.set_defaults(fn=cmd_build_page)
    a = sub.add_parser("export-static"); a.add_argument("--data", default=str(ROOT / "dashboard" / "dashboard_data.json")); a.add_argument("--out", default=str(ROOT / "public")); a.set_defaults(fn=cmd_export_static)
    a = sub.add_parser("refit-linkage"); a.set_defaults(fn=cmd_refit)
    a = sub.add_parser("serve"); a.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to allow other computers on the network"); a.add_argument("--port", type=int, default=8000); a.set_defaults(fn=cmd_serve)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
