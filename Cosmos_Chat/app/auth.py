import secrets
from datetime import datetime, timezone
from passlib.context import CryptContext
from fastapi import Header, HTTPException
from .db import db

pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

def now():
    return datetime.now(timezone.utc).isoformat()

def hash_password(password: str) -> str:
    return pwd.hash(password)

def verify_password(password: str, password_hash: str) -> bool:
    return pwd.verify(password, password_hash)

def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    with db() as conn:
        conn.execute(
            "INSERT INTO sessions(token, user_id, created_at) VALUES(?,?,?)",
            (token, user_id, now()),
        )
    return token

def get_user_by_token(token: str):
    with db() as conn:
        row = conn.execute(
            """SELECT u.* FROM sessions s
               JOIN users u ON u.id=s.user_id
               WHERE s.token=?""",
            (token,),
        ).fetchone()
        return row

def require_user(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Authentication required")
    token = authorization.split(" ", 1)[1].strip()
    user = get_user_by_token(token)
    if not user:
        raise HTTPException(401, "Invalid session")
    return dict(user)
