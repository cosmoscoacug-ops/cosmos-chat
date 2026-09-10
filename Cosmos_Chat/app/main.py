from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from datetime import datetime, timezone
import os, shutil, uuid, mimetypes

from .db import init_db, db
from .auth import require_user, hash_password, verify_password, create_session, get_user_by_token, now
from .models import *
from .realtime import hub

BASE = Path(__file__).resolve().parent
UPLOADS = Path(os.getenv("COSMOS_CHAT_UPLOADS", "uploads"))
UPLOADS.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Cosmos Chat", version="1.0.0")
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOADS), name="uploads")

@app.on_event("startup")
def startup():
    init_db()

def public_user(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "email": row["email"],
        "display_name": row["display_name"],
        "bio": row["bio"],
        "avatar_url": row["avatar_url"],
        "last_seen": row["last_seen"],
        "online": hub.is_online(row["id"]),
    }

def chat_member_ids(conn, chat_id):
    return [r["user_id"] for r in conn.execute(
        "SELECT user_id FROM chat_members WHERE chat_id=?", (chat_id,)
    ).fetchall()]

def ensure_member(conn, chat_id, user_id):
    row = conn.execute(
        "SELECT * FROM chat_members WHERE chat_id=? AND user_id=?",
        (chat_id, user_id),
    ).fetchone()
    if not row:
        raise HTTPException(403, "You are not a member of this chat")
    return row

def serialize_message(conn, row, user_id=None):
    sender = conn.execute("SELECT * FROM users WHERE id=?", (row["sender_id"],)).fetchone()
    reply = None
    if row["reply_to"]:
        r = conn.execute("SELECT id, body, sender_id, deleted FROM messages WHERE id=?", (row["reply_to"],)).fetchone()
        if r:
            reply = dict(r)
    reactions = [dict(x) for x in conn.execute(
        "SELECT emoji, COUNT(*) AS count FROM reactions WHERE message_id=? GROUP BY emoji",
        (row["id"],)
    ).fetchall()]
    readers = conn.execute("SELECT COUNT(*) AS c FROM message_reads WHERE message_id=?", (row["id"],)).fetchone()["c"]
    starred = False
    if user_id:
        starred = bool(conn.execute(
            "SELECT 1 FROM starred_messages WHERE message_id=? AND user_id=?",
            (row["id"], user_id)
        ).fetchone())
    return {
        "id": row["id"],
        "chat_id": row["chat_id"],
        "sender_id": row["sender_id"],
        "sender_name": sender["display_name"] if sender else "Unknown",
        "body": "" if row["deleted"] else row["body"],
        "attachment_url": "" if row["deleted"] else row["attachment_url"],
        "attachment_name": "" if row["deleted"] else row["attachment_name"],
        "attachment_type": "" if row["deleted"] else row["attachment_type"],
        "reply": reply,
        "edited": bool(row["edited"]),
        "deleted": bool(row["deleted"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "reactions": reactions,
        "read_count": readers,
        "starred": starred,
    }

def serialize_chat(conn, row, user_id):
    chat_id = row["id"]
    members = [public_user(x) for x in conn.execute(
        """SELECT u.* FROM users u JOIN chat_members cm ON cm.user_id=u.id
           WHERE cm.chat_id=? ORDER BY u.display_name""",
        (chat_id,)
    ).fetchall()]
    prefs = conn.execute(
        "SELECT * FROM chat_members WHERE chat_id=? AND user_id=?",
        (chat_id, user_id)
    ).fetchone()
    last = conn.execute(
        "SELECT * FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1",
        (chat_id,)
    ).fetchone()
    unread = conn.execute(
        """SELECT COUNT(*) AS c FROM messages m
           WHERE m.chat_id=? AND m.sender_id<>? AND m.deleted=0
           AND NOT EXISTS(
             SELECT 1 FROM message_reads r WHERE r.message_id=m.id AND r.user_id=?
           )""",
        (chat_id, user_id, user_id)
    ).fetchone()["c"]
    title = row["title"]
    avatar_url = ""
    if row["kind"] == "direct":
        other = next((m for m in members if m["id"] != user_id), None)
        if other:
            title = other["display_name"]
            avatar_url = other["avatar_url"]
    return {
        "id": chat_id,
        "kind": row["kind"],
        "title": title or "Untitled chat",
        "avatar_url": avatar_url,
        "members": members,
        "last_message": serialize_message(conn, last, user_id) if last else None,
        "unread": unread,
        "pinned": bool(prefs["pinned"]),
        "archived": bool(prefs["archived"]),
        "muted": bool(prefs["muted"]),
        "wallpaper": prefs["wallpaper"] or "",
        "role": prefs["role"],
    }

@app.get("/", response_class=HTMLResponse)
def index():
    return (BASE / "templates" / "index.html").read_text(encoding="utf-8")

@app.get("/health")
def health():
    return {"ok": True, "name": "Cosmos Chat"}

@app.post("/api/auth/register")
def register(data: RegisterIn):
    username = data.username.strip().lower()
    if not username.replace("_","").isalnum():
        raise HTTPException(400, "Username can contain letters, numbers, and underscores")
    with db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            raise HTTPException(409, "Username already exists")
        email = data.email.strip().lower()
        if "@" not in email or "." not in email.split("@")[-1]:
            raise HTTPException(400, "Enter a valid email address")
        if conn.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            raise HTTPException(409, "Email address already exists")
        cur = conn.execute(
            """INSERT INTO users(username,email,display_name,password_hash,created_at,last_seen)
               VALUES(?,?,?,?,?,?)""",
            (username, email, data.display_name.strip(), hash_password(data.password), now(), now())
        )
        uid = cur.lastrowid
    return {"token": create_session(uid)}

@app.post("/api/auth/login")
def login(data: LoginIn):
    with db() as conn:
        identity = data.username.strip().lower()
        row = conn.execute("SELECT * FROM users WHERE username=? OR email=?", (identity, identity)).fetchone()
        if not row or not verify_password(data.password, row["password_hash"]):
            raise HTTPException(401, "Invalid username or password")
        conn.execute("UPDATE users SET last_seen=? WHERE id=?", (now(), row["id"]))
        uid = row["id"]
    return {"token": create_session(uid)}

@app.post("/api/auth/logout")
def logout(user=Depends(require_user), authorization: str | None = None):
    return {"ok": True}

@app.get("/api/me")
def me(user=Depends(require_user)):
    return public_user(user)

@app.put("/api/me")
def update_me(data: ProfileIn, user=Depends(require_user)):
    with db() as conn:
        conn.execute(
            "UPDATE users SET display_name=?, bio=?, avatar_url=? WHERE id=?",
            (data.display_name.strip(), data.bio.strip(), data.avatar_url.strip(), user["id"])
        )
        row = conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
    return public_user(row)

@app.get("/api/users")
def users(q: str = "", user=Depends(require_user)):
    with db() as conn:
        like = f"%{q.strip()}%"
        rows = conn.execute(
            """SELECT * FROM users
               WHERE id<>? AND (display_name LIKE ? OR username LIKE ? OR email LIKE ?)
               ORDER BY display_name LIMIT 50""",
            (user["id"], like, like, like)
        ).fetchall()
    return [public_user(r) for r in rows]

@app.get("/api/contacts")
def list_contacts(user=Depends(require_user)):
    with db() as conn:
        rows = conn.execute("""SELECT u.*, c.nickname FROM contacts c JOIN users u ON u.id=c.contact_user_id WHERE c.owner_id=? ORDER BY u.display_name""", (user["id"],)).fetchall()
    return [{**public_user(r), "nickname": r["nickname"]} for r in rows]

@app.post("/api/contacts")
def add_contact(data: ContactIn, user=Depends(require_user)):
    value=data.contact.strip().lower()
    with db() as conn:
        target=conn.execute("SELECT * FROM users WHERE lower(username)=? OR lower(email)=?", (value,value)).fetchone()
        if not target: raise HTTPException(404, "No account matches that username or email")
        if target["id"]==user["id"]: raise HTTPException(400, "You cannot add yourself")
        conn.execute("INSERT INTO contacts(owner_id,contact_user_id,nickname,created_at) VALUES(?,?,?,?) ON CONFLICT(owner_id,contact_user_id) DO UPDATE SET nickname=excluded.nickname", (user["id"],target["id"],data.nickname.strip(),now()))
    return public_user(target)

@app.delete("/api/contacts/{contact_user_id}")
def delete_contact(contact_user_id:int, user=Depends(require_user)):
    with db() as conn: conn.execute("DELETE FROM contacts WHERE owner_id=? AND contact_user_id=?", (user["id"],contact_user_id))
    return {"ok":True}

@app.get("/api/chats")
def list_chats(user=Depends(require_user)):
    with db() as conn:
        rows = conn.execute(
            """SELECT c.* FROM chats c
               JOIN chat_members cm ON cm.chat_id=c.id
               WHERE cm.user_id=?
               ORDER BY cm.pinned DESC,
                        COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.chat_id=c.id), c.id) DESC""",
            (user["id"],)
        ).fetchall()
        return [serialize_chat(conn, r, user["id"]) for r in rows]

@app.post("/api/chats/direct")
async def create_direct(data: DirectChatIn, user=Depends(require_user)):
    if data.user_id == user["id"]:
        raise HTTPException(400, "Choose another user")
    with db() as conn:
        exists = conn.execute("SELECT 1 FROM users WHERE id=?", (data.user_id,)).fetchone()
        if not exists:
            raise HTTPException(404, "User not found")
        existing = conn.execute(
            """SELECT c.id FROM chats c
               JOIN chat_members a ON a.chat_id=c.id AND a.user_id=?
               JOIN chat_members b ON b.chat_id=c.id AND b.user_id=?
               WHERE c.kind='direct'
               AND (SELECT COUNT(*) FROM chat_members cm WHERE cm.chat_id=c.id)=2
               LIMIT 1""",
            (user["id"], data.user_id)
        ).fetchone()
        if existing:
            row = conn.execute("SELECT * FROM chats WHERE id=?", (existing["id"],)).fetchone()
            return serialize_chat(conn, row, user["id"])
        cur = conn.execute("INSERT INTO chats(kind,title,created_by,created_at) VALUES('direct','',?,?)",
                           (user["id"], now()))
        cid = cur.lastrowid
        for uid in [user["id"], data.user_id]:
            conn.execute("INSERT INTO chat_members(chat_id,user_id,role,joined_at) VALUES(?,?,?,?)",
                         (cid, uid, "member", now()))
        row = conn.execute("SELECT * FROM chats WHERE id=?", (cid,)).fetchone()
        payload = serialize_chat(conn, row, user["id"])
    await hub.send_many([user["id"], data.user_id], {"type":"chat_created","chat_id":cid})
    return payload

@app.post("/api/chats/group")
async def create_group(data: GroupIn, user=Depends(require_user)):
    ids = sorted(set([user["id"], *data.member_ids]))
    with db() as conn:
        valid = {r["id"] for r in conn.execute(
            f"SELECT id FROM users WHERE id IN ({','.join('?' * len(ids))})", ids
        ).fetchall()}
        ids = [i for i in ids if i in valid]
        cur = conn.execute(
            "INSERT INTO chats(kind,title,created_by,created_at) VALUES('group',?,?,?)",
            (data.title.strip(), user["id"], now())
        )
        cid = cur.lastrowid
        for uid in ids:
            conn.execute(
                "INSERT INTO chat_members(chat_id,user_id,role,joined_at) VALUES(?,?,?,?)",
                (cid, uid, "admin" if uid == user["id"] else "member", now())
            )
        row = conn.execute("SELECT * FROM chats WHERE id=?", (cid,)).fetchone()
        out = serialize_chat(conn, row, user["id"])
    await hub.send_many(ids, {"type":"chat_created","chat_id":cid})
    return out

@app.post("/api/chats/{chat_id}/members")
async def add_members(chat_id: int, data: GroupMembersIn, user=Depends(require_user)):
    with db() as conn:
        me = ensure_member(conn, chat_id, user["id"])
        chat = conn.execute("SELECT * FROM chats WHERE id=?", (chat_id,)).fetchone()
        if not chat or chat["kind"] != "group":
            raise HTTPException(400, "Not a group")
        if me["role"] != "admin":
            raise HTTPException(403, "Admin required")
        for uid in set(data.user_ids):
            if conn.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
                conn.execute(
                    "INSERT OR IGNORE INTO chat_members(chat_id,user_id,role,joined_at) VALUES(?,?,?,?)",
                    (chat_id, uid, "member", now())
                )
        ids = chat_member_ids(conn, chat_id)
    await hub.send_many(ids, {"type":"chat_updated","chat_id":chat_id})
    return {"ok": True}

@app.delete("/api/chats/{chat_id}/members/{member_id}")
async def remove_member(chat_id: int, member_id: int, user=Depends(require_user)):
    with db() as conn:
        me = ensure_member(conn, chat_id, user["id"])
        chat = conn.execute("SELECT * FROM chats WHERE id=?", (chat_id,)).fetchone()
        if not chat or chat["kind"] != "group":
            raise HTTPException(400, "Not a group")
        if member_id != user["id"] and me["role"] != "admin":
            raise HTTPException(403, "Admin required")
        conn.execute("DELETE FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, member_id))
        ids = chat_member_ids(conn, chat_id)
    await hub.send_many(ids + [member_id], {"type":"chat_updated","chat_id":chat_id})
    return {"ok": True}

@app.put("/api/chats/{chat_id}/prefs")
async def chat_prefs(chat_id: int, data: ChatPrefsIn, user=Depends(require_user)):
    sets, values = [], []
    for key in ("pinned","archived","muted","wallpaper"):
        value = getattr(data, key)
        if value is not None:
            sets.append(f"{key}=?")
            values.append(int(value) if isinstance(value, bool) else value)
    if not sets:
        return {"ok": True}
    with db() as conn:
        ensure_member(conn, chat_id, user["id"])
        values += [chat_id, user["id"]]
        conn.execute(f"UPDATE chat_members SET {', '.join(sets)} WHERE chat_id=? AND user_id=?", values)
    return {"ok": True}

@app.get("/api/chats/{chat_id}/messages")
def messages(chat_id: int, before: int | None = None, search: str = "", user=Depends(require_user)):
    with db() as conn:
        ensure_member(conn, chat_id, user["id"])
        sql = "SELECT * FROM messages WHERE chat_id=?"
        params = [chat_id]
        if before:
            sql += " AND id<?"
            params.append(before)
        if search:
            sql += " AND body LIKE ?"
            params.append(f"%{search}%")
        sql += " ORDER BY id DESC LIMIT 100"
        rows = conn.execute(sql, params).fetchall()
        return [serialize_message(conn, r, user["id"]) for r in reversed(rows)]

@app.post("/api/chats/{chat_id}/messages")
async def send_message(chat_id: int, data: MessageIn, user=Depends(require_user)):
    body = data.body.strip()
    if not body:
        raise HTTPException(400, "Message cannot be empty")
    with db() as conn:
        ensure_member(conn, chat_id, user["id"])
        if data.reply_to:
            r = conn.execute("SELECT 1 FROM messages WHERE id=? AND chat_id=?", (data.reply_to, chat_id)).fetchone()
            if not r:
                raise HTTPException(400, "Invalid reply target")
        cur = conn.execute(
            """INSERT INTO messages(chat_id,sender_id,body,reply_to,created_at)
               VALUES(?,?,?,?,?)""",
            (chat_id, user["id"], body, data.reply_to, now())
        )
        mid = cur.lastrowid
        conn.execute("INSERT OR IGNORE INTO message_reads(message_id,user_id,read_at) VALUES(?,?,?)",
                     (mid, user["id"], now()))
        row = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
        out = serialize_message(conn, row, user["id"])
        ids = chat_member_ids(conn, chat_id)
    await hub.send_many(ids, {"type":"message","message":out})
    return out

@app.post("/api/chats/{chat_id}/upload")
async def upload(chat_id: int, file: UploadFile = File(...), user=Depends(require_user)):
    with db() as conn:
        ensure_member(conn, chat_id, user["id"])
    safe_name = Path(file.filename or "file").name
    ext = Path(safe_name).suffix[:12]
    disk_name = f"{uuid.uuid4().hex}{ext}"
    dest = UPLOADS / disk_name
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    mime = file.content_type or mimetypes.guess_type(safe_name)[0] or "application/octet-stream"
    url = f"/uploads/{disk_name}"
    with db() as conn:
        cur = conn.execute(
            """INSERT INTO messages(chat_id,sender_id,body,attachment_url,attachment_name,attachment_type,created_at)
               VALUES(?,?,?,?,?,?,?)""",
            (chat_id, user["id"], "", url, safe_name, mime, now())
        )
        mid = cur.lastrowid
        conn.execute("INSERT OR IGNORE INTO message_reads(message_id,user_id,read_at) VALUES(?,?,?)",
                     (mid, user["id"], now()))
        row = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
        out = serialize_message(conn, row, user["id"])
        ids = chat_member_ids(conn, chat_id)
    await hub.send_many(ids, {"type":"message","message":out})
    return out

@app.put("/api/messages/{message_id}")
async def edit_message(message_id: int, data: MessageEditIn, user=Depends(require_user)):
    with db() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Message not found")
        if row["sender_id"] != user["id"]:
            raise HTTPException(403, "You can only edit your own messages")
        conn.execute("UPDATE messages SET body=?, edited=1, updated_at=? WHERE id=?",
                     (data.body.strip(), now(), message_id))
        updated = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        out = serialize_message(conn, updated, user["id"])
        ids = chat_member_ids(conn, row["chat_id"])
    await hub.send_many(ids, {"type":"message_updated","message":out})
    return out

@app.delete("/api/messages/{message_id}")
async def delete_message(message_id: int, user=Depends(require_user)):
    with db() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Message not found")
        if row["sender_id"] != user["id"]:
            raise HTTPException(403, "You can only delete your own messages")
        conn.execute("UPDATE messages SET deleted=1, body='', attachment_url='', updated_at=? WHERE id=?",
                     (now(), message_id))
        updated = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        out = serialize_message(conn, updated, user["id"])
        ids = chat_member_ids(conn, row["chat_id"])
    await hub.send_many(ids, {"type":"message_updated","message":out})
    return {"ok": True}

@app.post("/api/messages/{message_id}/read")
async def mark_read(message_id: int, user=Depends(require_user)):
    with db() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Message not found")
        ensure_member(conn, row["chat_id"], user["id"])
        conn.execute("INSERT OR REPLACE INTO message_reads(message_id,user_id,read_at) VALUES(?,?,?)",
                     (message_id, user["id"], now()))
        ids = chat_member_ids(conn, row["chat_id"])
    await hub.send_many(ids, {"type":"read","message_id":message_id,"user_id":user["id"]})
    return {"ok": True}

@app.post("/api/messages/{message_id}/reaction")
async def reaction(message_id: int, data: ReactionIn, user=Depends(require_user)):
    with db() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Message not found")
        ensure_member(conn, row["chat_id"], user["id"])
        existing = conn.execute(
            "SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?",
            (message_id, user["id"], data.emoji)
        ).fetchone()
        if existing:
            conn.execute("DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?",
                         (message_id, user["id"], data.emoji))
        else:
            conn.execute("INSERT INTO reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?)",
                         (message_id, user["id"], data.emoji, now()))
        updated = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        out = serialize_message(conn, updated, user["id"])
        ids = chat_member_ids(conn, row["chat_id"])
    await hub.send_many(ids, {"type":"message_updated","message":out})
    return {"ok": True}

@app.post("/api/messages/{message_id}/star")
def star(message_id: int, user=Depends(require_user)):
    with db() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Message not found")
        ensure_member(conn, row["chat_id"], user["id"])
        exists = conn.execute("SELECT 1 FROM starred_messages WHERE message_id=? AND user_id=?",
                              (message_id, user["id"])).fetchone()
        if exists:
            conn.execute("DELETE FROM starred_messages WHERE message_id=? AND user_id=?",
                         (message_id, user["id"]))
            return {"starred": False}
        conn.execute("INSERT INTO starred_messages(message_id,user_id,created_at) VALUES(?,?,?)",
                     (message_id, user["id"], now()))
        return {"starred": True}

@app.get("/api/starred")
def starred(user=Depends(require_user)):
    with db() as conn:
        rows = conn.execute(
            """SELECT m.* FROM messages m JOIN starred_messages s ON s.message_id=m.id
               WHERE s.user_id=? ORDER BY s.created_at DESC LIMIT 200""",
            (user["id"],)
        ).fetchall()
        return [serialize_message(conn, r, user["id"]) for r in rows]

@app.post("/api/messages/{message_id}/forward")
async def forward_message(message_id:int, data:ForwardIn, user=Depends(require_user)):
    out=[]
    with db() as conn:
        source=conn.execute("SELECT * FROM messages WHERE id=?",(message_id,)).fetchone()
        if not source: raise HTTPException(404,"Message not found")
        ensure_member(conn,source["chat_id"],user["id"])
        for cid in sorted(set(data.target_chat_ids)):
            ensure_member(conn,cid,user["id"])
            cur=conn.execute("INSERT INTO messages(chat_id,sender_id,body,attachment_url,attachment_name,attachment_type,created_at) VALUES(?,?,?,?,?,?,?)",(cid,user["id"],source["body"],source["attachment_url"],source["attachment_name"],source["attachment_type"],now()))
            mid=cur.lastrowid
            conn.execute("INSERT OR IGNORE INTO message_reads(message_id,user_id,read_at) VALUES(?,?,?)",(mid,user["id"],now()))
            row=conn.execute("SELECT * FROM messages WHERE id=?",(mid,)).fetchone()
            msg=serialize_message(conn,row,user["id"]); out.append(msg)
            ids=chat_member_ids(conn,cid)
            # notify after transaction below
    for msg in out:
        with db() as conn: ids=chat_member_ids(conn,msg["chat_id"])
        await hub.send_many(ids,{"type":"message","message":msg})
    return {"messages":out}

@app.websocket("/ws")
async def ws(ws: WebSocket, token: str):
    user = get_user_by_token(token)
    if not user:
        await ws.close(code=4401)
        return
    uid = user["id"]
    await hub.connect(uid, ws)
    with db() as conn:
        conn.execute("UPDATE users SET last_seen=? WHERE id=?", (now(), uid))
        peer_ids = [r["user_id"] for r in conn.execute(
            """SELECT DISTINCT cm2.user_id FROM chat_members cm
               JOIN chat_members cm2 ON cm2.chat_id=cm.chat_id
               WHERE cm.user_id=? AND cm2.user_id<>?""",
            (uid, uid)
        ).fetchall()]
    await hub.send_many(peer_ids, {"type":"presence","user_id":uid,"online":True})
    try:
        while True:
            data = await ws.receive_json()
            typ = data.get("type")
            chat_id = data.get("chat_id")
            if typ in {"typing","call_offer","call_answer","ice","call_end"} and chat_id:
                with db() as conn:
                    ensure_member(conn, int(chat_id), uid)
                    ids = [x for x in chat_member_ids(conn, int(chat_id)) if x != uid]
                payload = dict(data)
                payload["user_id"] = uid
                await hub.send_many(ids, payload)
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(uid, ws)
        with db() as conn:
            conn.execute("UPDATE users SET last_seen=? WHERE id=?", (now(), uid))
        await hub.send_many(peer_ids, {"type":"presence","user_id":uid,"online":False,"last_seen":now()})
