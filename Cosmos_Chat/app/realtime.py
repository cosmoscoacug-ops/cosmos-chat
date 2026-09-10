from fastapi import WebSocket
from collections import defaultdict
import asyncio

class Hub:
    def __init__(self):
        self.user_sockets: dict[int, set[WebSocket]] = defaultdict(set)
        self.lock = asyncio.Lock()

    async def connect(self, user_id: int, ws: WebSocket):
        await ws.accept()
        async with self.lock:
            self.user_sockets[user_id].add(ws)

    async def disconnect(self, user_id: int, ws: WebSocket):
        async with self.lock:
            self.user_sockets[user_id].discard(ws)
            if not self.user_sockets[user_id]:
                self.user_sockets.pop(user_id, None)

    def is_online(self, user_id: int) -> bool:
        return bool(self.user_sockets.get(user_id))

    async def send_user(self, user_id: int, payload: dict):
        dead = []
        for ws in list(self.user_sockets.get(user_id, ())):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.disconnect(user_id, ws)

    async def send_many(self, user_ids: list[int], payload: dict):
        for uid in set(user_ids):
            await self.send_user(uid, payload)

hub = Hub()
