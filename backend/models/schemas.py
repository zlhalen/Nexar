from __future__ import annotations

from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


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


class TerminalSessionResizeRequest(BaseModel):
    cols: int
    rows: int


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
    # legacy run-step compatibility
    index: int
    name: str
    kind: str
    goal: str
    status: str = "pending"
    attempts: int = 0
    error: Optional[str] = None


class ActionType(str, Enum):
    SCAN_WORKSPACE = "scan_workspace"
    READ_FILES = "read_files"
    SEARCH_CODE = "search_code"
    EXTRACT_SYMBOLS = "extract_symbols"
    ANALYZE_DEPENDENCIES = "analyze_dependencies"
    SUMMARIZE_CONTEXT = "summarize_context"
    PROPOSE_SUBPLAN = "propose_subplan"
    RUN_COMMAND = "run_command"
    RUN_TESTS = "run_tests"
    RUN_LINT = "run_lint"
    RUN_BUILD = "run_build"
    CREATE_FILE = "create_file"
    UPDATE_FILE = "update_file"
    DELETE_FILE = "delete_file"
    MOVE_FILE = "move_file"
    APPLY_PATCH = "apply_patch"
    VALIDATE_RESULT = "validate_result"
    ASK_USER = "ask_user"
    REQUEST_APPROVAL = "request_approval"
    FINAL_ANSWER = "final_answer"
    REPORT_BLOCKER = "report_blocker"


class ActionFailurePolicy(BaseModel):
    strategy: str = "replan"  # retry | replan | ask_user | abort
    fallback_actions: list["ActionSpec"] = Field(default_factory=list)


class ActionSpec(BaseModel):
    id: str
    type: ActionType
    title: str
    reason: str
    input: dict[str, Any] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list)
    can_parallel: bool = False
    priority: int = 3
    timeout_sec: int = 120
    max_retries: int = 1
    success_criteria: list[str] = Field(default_factory=list)
    on_failure: Optional[ActionFailurePolicy] = None
    artifacts: list[str] = Field(default_factory=list)


class ActionBatchDecision(BaseModel):
    mode: str  # continue | ask_user | done | blocked
    reason: Optional[str] = None
    needs_user_trigger: bool = True
    satisfaction_score: Optional[float] = None


class ActionBatch(BaseModel):
    version: str = "1.0"
    iteration: int
    summary: str
    decision: ActionBatchDecision
    actions: list[ActionSpec] = Field(default_factory=list)
    acceptance: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    next_questions: list[str] = Field(default_factory=list)


class ActionExecutionRecord(BaseModel):
    iteration: int
    action_id: str
    action_type: ActionType
    status: str  # queued | running | completed | failed | skipped | blocked
    title: str
    reason: str
    input: dict[str, Any] = Field(default_factory=dict)
    output: dict[str, Any] = Field(default_factory=dict)
    artifacts: list[str] = Field(default_factory=list)
    error: Optional[str] = None
    started_at: Optional[str] = None
    ended_at: Optional[str] = None


class ExecutionEvent(BaseModel):
    event_id: str
    kind: str = "action"  # planning | action | system
    stage: str
    title: str
    detail: str = ""
    status: str = "info"  # info | queued | running | waiting_user | completed | failed | blocked
    timestamp: Optional[str] = None
    iteration: Optional[int] = None
    action_id: Optional[str] = None
    parent_action_id: Optional[str] = None
    data: dict[str, Any] = Field(default_factory=dict)
    input: Optional[dict[str, Any]] = None
    output: Optional[dict[str, Any]] = None
    metrics: Optional[dict[str, Any]] = None
    artifacts: list[str] = Field(default_factory=list)
    error: Optional[str] = None


class AIRequestSnapshot(BaseModel):
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


class PlanRunInfo(BaseModel):
    run_id: str
    intent: str
    status: str = "running"  # running | waiting_user | paused | completed | failed | blocked | cancelled
    max_retries: int = 3
    current_step_index: int = -1
    steps: list[StepRunInfo] = Field(default_factory=list)
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    iteration: int = 0
    latest_batch: Optional[ActionBatch] = None
    pending_action_ids: list[str] = Field(default_factory=list)
    pause_requested: bool = False
    cancel_requested: bool = False
    active_action_id: Optional[str] = None
    action_history: list[ActionExecutionRecord] = Field(default_factory=list)
    request_snapshot: Optional[AIRequestSnapshot] = None
    result_action: Optional[str] = None
    result_content: Optional[str] = None
    result_file_path: Optional[str] = None
    result_file_content: Optional[str] = None
    result_changes: list[FileChange] = Field(default_factory=list)
    events: list[ExecutionEvent] = Field(default_factory=list)


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
    run_id: Optional[str] = None
    needs_user_trigger: bool = False
    pending_actions: list[ActionSpec] = Field(default_factory=list)
