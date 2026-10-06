"""Authentication. Production: Firebase ID tokens verified with the Admin SDK.
Development: 'Bearer dev:<email>' tokens (refused when APP_ENV=production).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException

from .config import get_settings
from .store import get_store, init_firebase_app


@dataclass
class AuthUser:
    uid: str
    email: str
    verified: bool

    @property
    def is_admin(self) -> bool:
        s = get_settings()
        # In production the email must be verified by Firebase, so a spoofed address can't become admin.
        return self.email in s.admin_emails and (self.verified or s.auth_mode == "dev")

    @property
    def is_vip(self) -> bool:
        """Admins and listed emails get unlimited free access."""
        return self.is_admin or self.email in get_store().get_vip()


def current_user(authorization: str | None = Header(default=None)) -> AuthUser:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization[7:].strip()
    s = get_settings()
    if s.auth_mode == "dev":
        if not token.startswith("dev:") or "@" not in token:
            raise HTTPException(401, "Invalid dev token")
        email = token[4:].strip().lower()
        uid = "dev_" + hashlib.sha1(email.encode()).hexdigest()[:16]
        return AuthUser(uid=uid, email=email, verified=True)
    try:
        from firebase_admin import auth as fb_auth

        init_firebase_app()
        decoded = fb_auth.verify_id_token(token, check_revoked=False)
    except Exception as exc:  # noqa: BLE001 - any failure means unauthenticated
        raise HTTPException(401, "Invalid or expired token") from exc
    email = (decoded.get("email") or "").lower()
    if not email:
        raise HTTPException(401, "Account has no email")
    return AuthUser(uid=decoded["uid"], email=email, verified=bool(decoded.get("email_verified")))


def require_admin(user: AuthUser = Depends(current_user)) -> AuthUser:
    if not user.is_admin:
        raise HTTPException(403, "Admin only")
    return user
