from pydantic import BaseModel, Field

class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    email: str = Field(min_length=5, max_length=254)
    display_name: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=6, max_length=128)

class LoginIn(BaseModel):
    username: str
    password: str

class ProfileIn(BaseModel):
    display_name: str = Field(min_length=1, max_length=64)
    bio: str = Field(default="", max_length=180)
    avatar_url: str = Field(default="", max_length=500)

class DirectChatIn(BaseModel):
    user_id: int

class GroupIn(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    member_ids: list[int] = []

class GroupMembersIn(BaseModel):
    user_ids: list[int]

class MessageIn(BaseModel):
    body: str = Field(default="", max_length=8000)
    reply_to: int | None = None

class MessageEditIn(BaseModel):
    body: str = Field(min_length=1, max_length=8000)

class ReactionIn(BaseModel):
    emoji: str = Field(min_length=1, max_length=16)

class ChatPrefsIn(BaseModel):
    pinned: bool | None = None
    archived: bool | None = None
    muted: bool | None = None
    wallpaper: str | None = None


class ContactIn(BaseModel):
    contact: str = Field(min_length=3, max_length=254)
    nickname: str = Field(default="", max_length=64)

class ForwardIn(BaseModel):
    target_chat_ids: list[int]
