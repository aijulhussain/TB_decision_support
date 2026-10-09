"""Vercel serverless entry point: the whole FastAPI app as one function.

vercel.json rewrites the API paths (/auth, /patients, /referral-gaps, ...) here; the request keeps its original path,
so the app's routes match unchanged. The dashboard itself is served as static files from public/app/.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbds.api.main import app  # noqa: E402,F401  (Vercel looks for `app`)
