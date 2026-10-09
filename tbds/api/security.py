"""Authentication and role-based access control.

Roles and what they may do (least privilege):
  state_admin       all aggregated views, state-wide scope; patient-level lists in pilot districts; audit log; exports
  data_manager      duplicate review queue and data quality, state-wide scope; no risk lists
  district_officer  own district: facility priority, gaps, review lists, duplicates; death-audit queue
  facility_user     own facility: review list, gaps, actions
  field_worker      own facility: assigned review list and gaps (no exports)
"""
from __future__ import annotations

import threading
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from tbds.config import get_settings

oauth2 = OAuth2PasswordBearer(tokenUrl="/auth/token")
STATE_ROLES = {"state_admin", "data_manager"}

DEV_JWT_SECRET = "dev-only-change-me"
DEV_SALT = "dev-only-change-me-too"
DEV_DB_PASSWORD = "tbds_dev_password"
DEV_SEED_PASSWORD = "ChangeMe!2026"

# Set by the API at start-up: returns True when a token id has been revoked (signed out).
is_revoked: Callable[[str], bool] = lambda jti: False


@dataclass
class Principal:
    username: str
    role: str
    district: str | None
    facility_id: str | None
    display_name: str = ""
    jti: str | None = None
    exp: int | None = None


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except ValueError:
        return False


def create_token(p: Principal) -> str:
    cfg = get_settings().security
    exp = datetime.now(timezone.utc) + timedelta(minutes=int(cfg.jwt_minutes))
    return jwt.encode({"sub": p.username, "role": p.role, "district": p.district, "facility": p.facility_id, "name": p.display_name,
                       "exp": exp, "jti": uuid.uuid4().hex}, cfg.jwt_secret, algorithm="HS256")


def current_principal(token: str = Depends(oauth2)) -> Principal:
    try:
        d = jwt.decode(token, get_settings().security.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token", headers={"WWW-Authenticate": "Bearer"}) from exc
    if d.get("jti") and is_revoked(d["jti"]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Signed out", headers={"WWW-Authenticate": "Bearer"})
    return Principal(d["sub"], d["role"], d.get("district"), d.get("facility"), d.get("name", ""), d.get("jti"), d.get("exp"))


def require_roles(*roles: str):
    def dep(p: Principal = Depends(current_principal)) -> Principal:
        if p.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Role '{p.role}' is not permitted to use this resource")
        return p
    return dep


def scope(p: Principal, district_col: str = "district", facility_col: str | None = "facility_id") -> tuple[str, dict]:
    """SQL fragment limiting rows to the caller's scope."""
    if p.role in STATE_ROLES:
        return "TRUE", {}
    if p.role == "district_officer":
        return f"{district_col} = :_scope_district", {"_scope_district": p.district}
    if facility_col is None:
        return f"{district_col} = :_scope_district", {"_scope_district": p.district}
    return f"{facility_col} = :_scope_facility", {"_scope_facility": p.facility_id}


def mask(s: str | None) -> str:
    if not s:
        return ""
    return " ".join(w[0] + "*" * max(len(w) - 1, 2) for w in s.split())


# ---------------------------------------------------------------- sign-in lockout
class LoginLimiter:
    """Locks a username after repeated failed sign-ins. In-memory, so it applies per API process; behind several
    workers, put an equivalent limit on the reverse proxy as well (see docs/DEPLOYMENT.md)."""

    def __init__(self) -> None:
        self._fails: dict[str, deque] = defaultdict(deque)
        self._locked_until: dict[str, float] = {}
        self._lock = threading.Lock()

    def _cfg(self):
        c = get_settings().security
        return int(c.get("login_max_failures", 5)), 60 * float(c.get("login_window_minutes", 15)), 60 * float(c.get("login_lockout_minutes", 15))

    def check(self, username: str) -> None:
        with self._lock:
            until = self._locked_until.get(username.lower(), 0)
        if until > time.time():
            mins = max(1, round((until - time.time()) / 60))
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, f"Too many failed sign-ins. Try again in about {mins} minute(s).")

    def failed(self, username: str) -> None:
        n, window, lockout = self._cfg()
        now, key = time.time(), username.lower()
        with self._lock:
            q = self._fails[key]
            q.append(now)
            while q and q[0] < now - window:
                q.popleft()
            if len(q) >= n:
                self._locked_until[key] = now + lockout
                q.clear()

    def succeeded(self, username: str) -> None:
        with self._lock:
            self._fails.pop(username.lower(), None)
            self._locked_until.pop(username.lower(), None)


limiter = LoginLimiter()


# ---------------------------------------------------------------- production guard
def production_problems() -> list[str]:
    """Development defaults that must not reach production. Empty list means safe to start."""
    cfg = get_settings()
    probs = []
    sec = cfg.security
    if sec.jwt_secret == DEV_JWT_SECRET or len(str(sec.jwt_secret)) < 32:
        probs.append("TBDS__SECURITY__JWT_SECRET must be set to a random value of at least 32 characters")
    if sec.pseudonym_salt == DEV_SALT:
        probs.append("TBDS__SECURITY__PSEUDONYM_SALT must be set")
    from tbds.db.schema import database_url
    if DEV_DB_PASSWORD in database_url():
        probs.append("TBDS__DATABASE__URL still uses the development password")
    origins = cfg.get("app", {}).get("cors_origins", ["*"])
    if "*" in origins or "null" in origins:
        probs.append("TBDS__APP__CORS_ORIGINS must list exact origins (no '*' or 'null') in production")
    return probs
