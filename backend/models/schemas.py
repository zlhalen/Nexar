from pydantic import BaseModel, Field
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


class TerminalSessionCreateRequest(BaseModel):
    cwd: str = ""
    shell: str = "/bin/bash"


class TerminalSessionInfo(BaseModel):
    session_id: str
    cwd: str
    shell: str
    alive: bool = True
    exit_code: Optional[int] = None
    output: str = ""


class TerminalSessionInputRequest(BaseModel):
    data: str


class TerminalSessionOutputResponse(BaseModel):
    session_id: str
    output: str = ""
    alive: bool = True
    exit_code: Optional[int] = None


class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str
    chat_only: bool = False


class CodeSnippet(BaseModel):
    file_path: str
    start_line: int
    end_line: int
    content: str


class FileChange(BaseModel):
    file_path: str
    file_content: str
    before_content: Optional[str] = None
    after_content: Optional[str] = None
    diff_unified: Optional[str] = None
    before_hash: Optional[str] = None
    after_hash: Optional[str] = None
    write_result: str = "written"
    error: Optional[str] = None


class StepRunInfo(BaseModel):
    index: int
    name: str
    kind: str
    goal: str
    status: str = "pending"
    attempts: int = 0
    error: Optional[str] = None


class PlanRunInfo(BaseModel):
    run_id: str
    intent: str
    status: str = "running"
    max_retries: int = 3
    current_step_index: int = -1
    steps: list[StepRunInfo] = Field(default_factory=list)
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    result_action: Optional[str] = None
    result_content: Optional[str] = None
    result_file_path: Optional[str] = None
    result_file_content: Optional[str] = None
    result_changes: list[FileChange] = Field(default_factory=list)


class StartRunResponse(BaseModel):
    run_id: str


class AIRequest(BaseModel):
    provider: AIProvider = AIProvider.OPENAI
    messages: list[ChatMessage]
    current_file: Optional[str] = None
    current_code: Optional[str] = None
    file_path: Optional[str] = None
    range_start: Optional[int] = None
    range_end: Optional[int] = None
    snippets: Optional[list[CodeSnippet]] = None
    chat_only: bool = False
    planning_mode: bool = False
    force_code_edit: bool = False


class PlanStep(BaseModel):
    title: str
    detail: Optional[str] = None
    status: str = "pending"
    acceptance: Optional[str] = None


class PlanBlock(BaseModel):
    summary: str
    milestones: list[str] = Field(default_factory=list)
    steps: list[PlanStep] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)


class AIResponse(BaseModel):
    content: str
    file_path: Optional[str] = None
    file_content: Optional[str] = None
    action: str = "chat"
    plan: Optional[PlanBlock] = None
    changes: Optional[list[FileChange]] = None
    run: Optional[PlanRunInfo] = None
