from pydantic import BaseModel
from typing import Optional
from enum import Enum


class AIProvider(str, Enum):
    OPENAI = "openai"
    CLAUDE = "claude"
    CUSTOM = "custom"


class FileItem(BaseModel):
    name: str
    path: str
    is_dir: bool
    children: Optional[list["FileItem"]] = None


class FileContent(BaseModel):
    path: str
    content: str
    language: Optional[str] = None


class CreateFileRequest(BaseModel):
    path: str
    content: str = ""
    is_dir: bool = False


class RenameRequest(BaseModel):
    old_path: str
    new_path: str


class DeleteRequest(BaseModel):
    path: str


class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class AIRequest(BaseModel):
    provider: AIProvider = AIProvider.OPENAI
    messages: list[ChatMessage]
    current_file: Optional[str] = None
    current_code: Optional[str] = None
    action: str = "chat"  # "chat" | "generate" | "modify"
    file_path: Optional[str] = None


class AIResponse(BaseModel):
    content: str
    file_path: Optional[str] = None
    file_content: Optional[str] = None
    action: str = "chat"
