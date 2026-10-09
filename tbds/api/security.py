"""Authentication and role-based access control.

Roles and what they may do (least privilege):
  state_admin       all aggregated views, state-wide scope; patient-level lists in pilot districts; audit log; exports
  data_manager      duplicate review queue and data quality, state-wide scope; no risk lists
  district_officer  own district: facility priority, gaps, review lists, duplicates; death-audit queue
  facility_user     own facility: review list, gaps, actions
  field_worker      own facility: assigned review list and gaps (no exports)
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from tbds.config import get_settings

oauth2 = OAuth2PasswordBearer(tokenUrl="/auth/token")
STATE_ROLES = {"state_admin", "data_manager"}


@dataclass
class Principal:
    username: str
    role: str
    district: str | None
    facility_id: str | None
    display_name: str = ""


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except ValueError:
        return False


def create_token(p: Principal) -> str:
    cfg = get_settings().security
    exp = datetime.now(timezone.utc) + timedelta(minutes=int(cfg.jwt_minutes))
    return jwt.encode({"sub": p.username, "role": p.role, "district": p.district, "facility": p.facility_id, "name": p.display_name, "exp": exp},
                      cfg.jwt_secret, algorithm="HS256")


def current_principal(token: str = Depends(oauth2)) -> Principal:
    try:
        d = jwt.decode(token, get_settings().security.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token", headers={"WWW-Authenticate": "Bearer"}) from exc
    return Principal(d["sub"], d["role"], d.get("district"), d.get("facility"), d.get("name", ""))


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
