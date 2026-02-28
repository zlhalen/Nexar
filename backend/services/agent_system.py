from __future__ import annotations

import difflib
import hashlib
import logging
import re
import subprocess
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from backend.models.schemas import AIRequest, AIResponse, ChatMessage, FileChange, StepRunInfo
from backend.services import ai_service, file_service
from backend.services.plan_run_store import PlanRunStore

logger = logging.getLogger("agent_system")


class IntentType(str, Enum):
    QA = "qa"
    CODE_EDIT = "code_edit"
    TERMINAL_COMMAND = "terminal_command"


@dataclass
class PlanStep:
    name: str
    kind: str  # "llm" | "terminal"
    goal: str
    expects_write: bool = False
    planning_mode: bool = False
    chat_only: bool = False
    terminal_command: str | None = None


@dataclass
class ExecutionPlan:
    intent: IntentType
    steps: list[PlanStep]


@dataclass
class TerminalResult:
    command: str
    returncode: int
    stdout: str
    stderr: str


class IntentRouter:
    """Route request intent from user input and flags."""

    _terminal_markers = ("/cmd ", "!cmd ", "run command:", "执行命令:")
    _edit_markers = (
        "modify", "change", "edit", "refactor", "rewrite", "fix", "optimize",
        "修改", "重构", "优化", "修复", "调整", "改一下", "改成",
    )

    def route(self, req: AIRequest) -> IntentType:
        text = self._latest_user_text(req).lower().strip()
        if req.force_code_edit:
            intent = IntentType.CODE_EDIT
            logger.info(
                "[IntentRouter] intent=%s reason=force_code_edit current_file=%s text_preview=%s",
                intent.value,
                req.current_file,
                text[:120],
            )
            return intent
        if any(text.startswith(prefix) for prefix in self._terminal_markers):
            intent = IntentType.TERMINAL_COMMAND
            logger.info("[IntentRouter] intent=%s reason=terminal_marker text_preview=%s", intent.value, text[:120])
            return intent

        if req.planning_mode or req.chat_only:
            intent = IntentType.QA
            logger.info(
                "[IntentRouter] intent=%s reason=flags planning_mode=%s chat_only=%s text_preview=%s",
                intent.value,
                req.planning_mode,
                req.chat_only,
                text[:120],
            )
            return intent

        if req.file_path or req.current_file or self._has_edit_marker(text):
            intent = IntentType.CODE_EDIT
            logger.info(
                "[IntentRouter] intent=%s reason=edit_signal file_path=%s current_file=%s text_preview=%s",
                intent.value,
                req.file_path,
                req.current_file,
                text[:120],
            )
            return intent

        intent = IntentType.QA
        logger.info("[IntentRouter] intent=%s reason=default text_preview=%s", intent.value, text[:120])
        return intent

    def _latest_user_text(self, req: AIRequest) -> str:
        for msg in reversed(req.messages):
            if msg.role == "user":
                return msg.content
        return ""

    def _has_edit_marker(self, text: str) -> bool:
        return any(marker in text for marker in self._edit_markers)


class TaskPlanner:
    """Build a structured step list from intent."""

    def make_plan(self, intent: IntentType, req: AIRequest, context: str) -> ExecutionPlan:
        if intent == IntentType.TERMINAL_COMMAND:
            command = self._extract_command(req)
            plan = ExecutionPlan(
                intent=intent,
                steps=[
                    PlanStep(
                        name="terminal_exec",
                        kind="terminal",
                        goal="Execute terminal command with captured output",
                        terminal_command=command,
                        chat_only=True,
                    )
                ],
            )
            self._log_plan(plan, context)
            return plan

        if req.planning_mode:
            plan = ExecutionPlan(
                intent=intent,
                steps=[
                    PlanStep(
                        name="planning",
                        kind="llm",
                        goal="Generate structured execution plan",
                        planning_mode=True,
                        chat_only=False,
                    )
                ],
            )
            self._log_plan(plan, context)
            return plan

        if intent == IntentType.CODE_EDIT and not req.chat_only:
            plan = ExecutionPlan(
                intent=intent,
                steps=[
                    PlanStep(
                        name="code_edit",
                        kind="llm",
                        goal="Produce concrete code updates",
                        expects_write=True,
                        chat_only=False,
                    )
                ],
            )
            self._log_plan(plan, context)
            return plan

        plan = ExecutionPlan(
            intent=intent,
            steps=[PlanStep(name="qa", kind="llm", goal="Answer the user query", chat_only=True)],
        )
        self._log_plan(plan, context)
        return plan

    def _extract_command(self, req: AIRequest) -> str:
        text = ""
        for msg in reversed(req.messages):
            if msg.role == "user":
                text = msg.content.strip()
                break
        for prefix in ("/cmd ", "!cmd ", "run command:", "执行命令:"):
            if text.lower().startswith(prefix):
                return text[len(prefix):].strip()
        return text

    def _log_plan(self, plan: ExecutionPlan, context: str) -> None:
        logger.info(
            "[TaskPlanner] intent=%s steps=%s context_chars=%d",
            plan.intent.value,
            [f"{s.name}:{s.kind}" for s in plan.steps],
            len(context),
        )


class Reflector:
    """Validate execution and generate retry strategy."""

    def __init__(self, max_retries: int = 3):
        self.max_retries = max_retries

    def validate_llm(self, step: PlanStep, result: AIResponse) -> tuple[bool, str | None]:
        if step.planning_mode:
            ok = result.action == "plan" or result.plan is not None
            if ok:
                logger.info("[Reflector] step=%s type=planning validation=ok", step.name)
                return True, None
            logger.warning("[Reflector] step=%s type=planning validation=failed reason=no_plan_json", step.name)
            return False, "上一次输出没有提供结构化计划。请严格返回 action=plan 的 JSON。"

        if step.expects_write:
            written = bool(result.changes) or (result.file_path and result.file_content)
            if written:
                logger.info("[Reflector] step=%s type=code_edit validation=ok", step.name)
                return True, None
            logger.warning("[Reflector] step=%s type=code_edit validation=failed reason=no_writes", step.name)
            return False, "上一次输出未产生可写入修改。请返回明确的文件变更。"

        logger.info("[Reflector] step=%s type=qa validation=ok", step.name)
        return True, None

    def validate_terminal(self, result: TerminalResult) -> tuple[bool, str | None]:
        if result.returncode == 0:
            logger.info("[Reflector] step=terminal validation=ok command=%s", result.command)
            return True, None
        logger.warning(
            "[Reflector] step=terminal validation=failed command=%s returncode=%d stderr_preview=%s",
            result.command,
            result.returncode,
            (result.stderr or "")[:160],
        )
        return False, f"命令执行失败（exit={result.returncode}），请修正命令或执行策略。"


class ExplicitContext:
    """Load explicit user-provided context (file path + snippets)."""

    def collect(self, req: AIRequest) -> str:
        blocks: list[str] = []
        if req.current_file and req.current_code:
            blocks.append(f"[ExplicitFile] {req.current_file}\n```text\n{req.current_code}\n```")
        elif req.current_file:
            try:
                content = file_service.read_file(req.current_file).content
                blocks.append(f"[ExplicitFile] {req.current_file}\n```text\n{content}\n```")
            except Exception:
                pass

        if req.snippets:
            for i, snip in enumerate(req.snippets, start=1):
                blocks.append(
                    f"[ExplicitSnippet#{i}] {snip.file_path}:{snip.start_line}-{snip.end_line}\n"
                    f"```text\n{snip.content}\n```"
                )
        logger.info(
            "[ExplicitContext] current_file=%s has_current_code=%s snippets=%d",
            req.current_file,
            bool(req.current_code),
            len(req.snippets or []),
        )
        return "\n\n".join(blocks)


class CodebaseSkeleton:
    """Build lightweight file tree + signature map."""

    _signature_patterns = (
        re.compile(r"^\s*def\s+([A-Za-z_]\w*)\s*\("),
        re.compile(r"^\s*class\s+([A-Za-z_]\w*)\s*[:\(]"),
        re.compile(r"^\s*function\s+([A-Za-z_]\w*)\s*\("),
        re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*="),
    )

    def collect(self, max_files: int = 80) -> str:
        root = Path(file_service.get_workspace_root())
        lines: list[str] = ["[CodebaseSkeleton]"]
        files = sorted(
            [p for p in root.rglob("*") if p.is_file() and not self._is_ignored(p)],
            key=lambda p: str(p),
        )[:max_files]
        for p in files:
            rel = str(p.relative_to(root))
            signatures = self._extract_signatures(p)
            if signatures:
                lines.append(f"- {rel}: {', '.join(signatures[:6])}")
            else:
                lines.append(f"- {rel}")
        logger.info("[CodebaseSkeleton] files_scanned=%d max_files=%d", len(files), max_files)
        return "\n".join(lines)

    def _extract_signatures(self, path: Path) -> list[str]:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return []
        found: list[str] = []
        for raw in text.splitlines():
            for pattern in self._signature_patterns:
                m = pattern.search(raw)
                if m:
                    found.append(m.group(1))
                    break
            if len(found) >= 12:
                break
        return found

    def _is_ignored(self, path: Path) -> bool:
        parts = set(path.parts)
        ignored_dirs = {".git", "node_modules", "__pycache__", ".idea", "dist", "build"}
        if parts.intersection(ignored_dirs):
            return True
        return path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".lock"}


class DependencyTracer:
    """Trace local dependencies from import/export statements."""

    _import_patterns = (
        re.compile(r'^\s*import\s+.*?\s+from\s+["\'](.+?)["\']'),
        re.compile(r'^\s*from\s+([A-Za-z0-9_\.]+)\s+import\s+'),
        re.compile(r'^\s*require\(["\'](.+?)["\']\)'),
    )

    def collect(self, target_file: str | None, max_deps: int = 12) -> str:
        if not target_file:
            logger.info("[DependencyTracer] skipped reason=no_target_file")
            return ""
        try:
            src = file_service.read_file(target_file).content
        except Exception:
            logger.warning("[DependencyTracer] failed_read target_file=%s", target_file)
            return ""
        deps = self._parse_imports(src)
        root = Path(file_service.get_workspace_root())
        blocks = ["[DependencyTracer]"]
        count = 0
        for dep in deps:
            resolved = self._resolve_dep(root, target_file, dep)
            if not resolved:
                continue
            try:
                content = file_service.read_file(resolved).content
            except Exception:
                continue
            blocks.append(f"- {resolved}\n```text\n{self._brief_content(content)}\n```")
            count += 1
            if count >= max_deps:
                break
        logger.info(
            "[DependencyTracer] target_file=%s import_count=%d resolved_deps=%d max_deps=%d",
            target_file,
            len(deps),
            count,
            max_deps,
        )
        return "\n".join(blocks) if count else ""

    def _parse_imports(self, source: str) -> list[str]:
        deps: list[str] = []
        for line in source.splitlines():
            for pattern in self._import_patterns:
                m = pattern.search(line)
                if m:
                    deps.append(m.group(1))
                    break
        return deps

    def _resolve_dep(self, root: Path, target_file: str, dep: str) -> str | None:
        if dep.startswith("."):
            base = (root / target_file).parent
            for suffix in ("", ".ts", ".tsx", ".js", ".jsx", ".py", ".json"):
                p = (base / f"{dep}{suffix}").resolve()
                if p.is_file() and str(p).startswith(str(root.resolve())):
                    return str(p.relative_to(root))
            index_candidates = ["index.ts", "index.tsx", "index.js", "__init__.py"]
            dep_dir = (base / dep).resolve()
            for idx in index_candidates:
                p = dep_dir / idx
                if p.is_file() and str(p).startswith(str(root.resolve())):
                    return str(p.relative_to(root))
            return None

        # Python module-like import.
        dotted = dep.replace(".", "/")
        for suffix in (".py", "/__init__.py"):
            p = root / f"{dotted}{suffix}"
            if p.is_file():
                return str(p.relative_to(root))
        return None

    def _brief_content(self, text: str, max_lines: int = 80) -> str:
        lines = text.splitlines()
        return "\n".join(lines[:max_lines])


class ContextAssembler:
    """Assemble context with strict priority and token budget."""

    def assemble(self, explicit_text: str, deps_text: str, skeleton_text: str, t_max: int = 6000) -> str:
        # Approx tokens: 1 token ~= 4 chars.
        c_max = max(0, t_max * 4)
        blocks = [explicit_text, deps_text, skeleton_text]
        merged = ""
        for block in blocks:
            if not block:
                continue
            if len(merged) + len(block) + 2 <= c_max:
                merged = (merged + "\n\n" + block).strip()
            else:
                remain = c_max - len(merged) - 2
                if remain > 128:
                    merged = (merged + "\n\n" + block[:remain]).strip()
                break
        logger.info(
            "[ContextAssembler] t_max=%d explicit_chars=%d deps_chars=%d skeleton_chars=%d final_chars=%d",
            t_max,
            len(explicit_text),
            len(deps_text),
            len(skeleton_text),
            len(merged),
        )
        return merged


class ContextEngine:
    """Facade for Context subsystem."""

    def __init__(self):
        self.explicit = ExplicitContext()
        self.skeleton = CodebaseSkeleton()
        self.deps = DependencyTracer()
        self.assembler = ContextAssembler()

    def build(self, req: AIRequest, t_max: int = 6000) -> str:
        explicit_text = self.explicit.collect(req)
        deps_text = self.deps.collect(req.current_file or req.file_path)
        skeleton_text = self.skeleton.collect()
        merged = self.assembler.assemble(explicit_text, deps_text, skeleton_text, t_max=t_max)
        logger.info("[ContextEngine] build_done final_chars=%d", len(merged))
        return merged


class FileEditor:
    """Perform write operations and produce audit-grade change records."""

    def apply(self, req: AIRequest, response: AIResponse) -> AIResponse:
        requested = self._collect_requested_changes(req, response)
        if not requested:
            logger.info("[FileEditor] no_requested_changes action=%s", response.action)
            return response
        logger.info("[FileEditor] requested_changes=%d action=%s", len(requested), response.action)

        written: list[FileChange] = []
        failed: list[FileChange] = []
        for change in requested:
            before = self._read_before(change.file_path)
            try:
                updated = self._write(req, response, change)
                after = updated.content
                written.append(
                    FileChange(
                        file_path=change.file_path,
                        file_content=after,
                        before_content=before,
                        after_content=after,
                        diff_unified=self._build_diff(change.file_path, before, after),
                        before_hash=self._text_hash(before),
                        after_hash=self._text_hash(after),
                        write_result="written",
                    )
                )
                logger.info(
                    "[FileEditor] write_ok file=%s before_len=%d after_len=%d",
                    change.file_path,
                    len(before),
                    len(after),
                )
            except Exception as err:
                failed.append(
                    FileChange(
                        file_path=change.file_path,
                        file_content=change.file_content,
                        before_content=before,
                        after_content=before,
                        diff_unified="",
                        before_hash=self._text_hash(before),
                        after_hash=self._text_hash(before),
                        write_result="failed",
                        error=str(err),
                    )
                )
                logger.warning("[FileEditor] write_failed file=%s error=%s", change.file_path, err)

        response.changes = written + failed
        if written:
            latest = written[-1]
            response.file_path = latest.file_path
            response.file_content = latest.after_content
        if failed:
            failed_paths = ", ".join(c.file_path for c in failed[:3])
            response.content = f"{response.content}\n\n部分文件写入失败: {failed_paths}".strip()
        logger.info("[FileEditor] write_summary success=%d failed=%d", len(written), len(failed))
        return response

    def _collect_requested_changes(self, req: AIRequest, response: AIResponse) -> list[FileChange]:
        if response.changes:
            return response.changes
        if response.file_content and response.action in ("generate", "modify"):
            target = response.file_path or req.file_path or req.current_file
            if not target:
                raise ValueError("Missing file path for write operation")
            return [FileChange(file_path=target, file_content=response.file_content)]
        return []

    def _read_before(self, path: str) -> str:
        try:
            return file_service.read_file(path).content
        except FileNotFoundError:
            return ""

    def _write(self, req: AIRequest, response: AIResponse, change: FileChange):
        if (
            response.action == "modify"
            and req.range_start is not None
            and req.range_end is not None
            and len(response.changes or []) <= 1
        ):
            return file_service.write_file_range(
                change.file_path,
                change.file_content,
                req.range_start,
                req.range_end,
            )
        if req.range_start is not None and req.range_end is not None and len(response.changes or []) > 1:
            raise ValueError("Range modify does not support multi-file changes")
        return file_service.write_file(change.file_path, change.file_content)

    def _text_hash(self, text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def _build_diff(self, path: str, before: str, after: str) -> str:
        diff = difflib.unified_diff(
            before.splitlines(),
            after.splitlines(),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
            lineterm="",
        )
        return "\n".join(diff)


class Terminal:
    """Execute CLI commands with safe exception capture."""

    def run(self, command: str) -> TerminalResult:
        if not command:
            raise ValueError("Terminal command cannot be empty")
        workspace = file_service.get_workspace_root()
        try:
            logger.info("[Terminal] exec command=%s cwd=%s", command, workspace)
            proc = subprocess.run(
                command,
                cwd=workspace,
                shell=True,
                capture_output=True,
                text=True,
                timeout=120,
            )
            return TerminalResult(
                command=command,
                returncode=proc.returncode,
                stdout=proc.stdout,
                stderr=proc.stderr,
            )
        except Exception as err:
            logger.exception("[Terminal] exec_exception command=%s", command)
            return TerminalResult(
                command=command,
                returncode=1,
                stdout="",
                stderr=str(err),
            )


class ExecutionLimbs:
    def __init__(self):
        self.file_editor = FileEditor()
        self.terminal = Terminal()


class BrainCore:
    def __init__(self, max_retries: int = 3):
        self.intent_router = IntentRouter()
        self.task_planner = TaskPlanner()
        self.reflector = Reflector(max_retries=max_retries)


class ClosedLoopAgent:
    """Closed loop orchestrator: BrainCore -> ContextEngine -> ExecutionLimbs."""

    def __init__(self):
        self.brain = BrainCore(max_retries=3)
        self.context_engine = ContextEngine()
        self.limbs = ExecutionLimbs()
        self.run_store = PlanRunStore()

    def create_run(self, req: AIRequest):
        intent = self.brain.intent_router.route(req)
        context = self.context_engine.build(req)
        plan = self.brain.task_planner.make_plan(intent, req, context)
        run = self.run_store.create_run(
            intent=plan.intent.value,
            steps=[
                StepRunInfo(index=i, name=s.name, kind=s.kind, goal=s.goal, status="pending")
                for i, s in enumerate(plan.steps)
            ],
            max_retries=self.brain.reflector.max_retries,
        )
        logger.info(
            "[ClosedLoopAgent] run_created run_id=%s intent=%s steps=%d",
            run.run_id,
            plan.intent.value,
            len(plan.steps),
        )
        return run.run_id

    async def execute_by_run_id(self, req: AIRequest, run_id: str) -> AIResponse:
        run = self.run_store.get(run_id)
        logger.info("[ClosedLoopAgent] execute_by_run_id run_id=%s", run_id)
        return await self._execute(req, run)

    async def execute(self, req: AIRequest) -> AIResponse:
        run_id = self.create_run(req)
        run = self.run_store.get(run_id)
        return await self._execute(req, run)

    async def _execute(self, req: AIRequest, run) -> AIResponse:
        intent = self.brain.intent_router.route(req)
        context = self.context_engine.build(req)
        plan = self.brain.task_planner.make_plan(intent, req, context)

        logger.info(
            "[ClosedLoopAgent] execute_start run_id=%s intent=%s steps=%d",
            run.run_id,
            plan.intent.value,
            len(plan.steps),
        )
        final_response: AIResponse | None = None

        for step_idx, step in enumerate(plan.steps):
            correction_hint: str | None = None
            self.run_store.mark_step_running(run, step_idx)
            logger.info(
                "[ClosedLoopAgent] step_start run_id=%s step_idx=%d step_name=%s kind=%s goal=%s",
                run.run_id,
                step_idx,
                step.name,
                step.kind,
                step.goal,
            )

            for attempt in range(1, self.brain.reflector.max_retries + 1):
                if step.kind == "terminal":
                    terminal_result = self.limbs.terminal.run(step.terminal_command or "")
                    ok, hint = self.brain.reflector.validate_terminal(terminal_result)
                    final_response = AIResponse(
                        action="chat",
                        content=(
                            f"[Terminal]\ncommand: {terminal_result.command}\n"
                            f"exit: {terminal_result.returncode}\n\n"
                            f"stdout:\n{terminal_result.stdout or '(empty)'}\n\n"
                            f"stderr:\n{terminal_result.stderr or '(empty)'}"
                        ),
                    )
                    if ok:
                        self.run_store.mark_step_completed(run, step_idx, attempt)
                        logger.info(
                            "[ClosedLoopAgent] step_done run_id=%s step_idx=%d attempt=%d",
                            run.run_id,
                            step_idx,
                            attempt,
                        )
                        break
                    correction_hint = hint
                    self.run_store.mark_step_retry(run, step_idx, attempt, hint or "terminal execution failed")
                    if attempt >= self.brain.reflector.max_retries:
                        self.run_store.mark_step_failed(run, step_idx, attempt, hint or "terminal execution failed")
                        logger.warning(
                            "[ClosedLoopAgent] step_failed run_id=%s step_idx=%d attempt=%d reason=%s",
                            run.run_id,
                            step_idx,
                            attempt,
                            hint,
                        )
                        break
                    continue

                messages = self._inject_context(req.messages, context, step.goal, correction_hint)
                logger.info(
                    "[ClosedLoopAgent] llm_call run_id=%s step_idx=%d attempt=%d messages=%d",
                    run.run_id,
                    step_idx,
                    attempt,
                    len(messages),
                )
                llm_result = await ai_service.chat(
                    provider=req.provider,
                    messages=messages,
                    current_file=req.current_file,
                    current_code=req.current_code,
                    file_path=req.file_path,
                    snippets=req.snippets,
                    chat_only=step.chat_only or req.chat_only,
                    planning_mode=step.planning_mode or req.planning_mode,
                    range_start=req.range_start,
                    range_end=req.range_end,
                )

                if step.expects_write and not req.chat_only and not req.planning_mode:
                    llm_result = self.limbs.file_editor.apply(req, llm_result)

                ok, hint = self.brain.reflector.validate_llm(step, llm_result)
                final_response = llm_result
                if ok:
                    self.run_store.mark_step_completed(run, step_idx, attempt)
                    logger.info(
                        "[ClosedLoopAgent] step_done run_id=%s step_idx=%d attempt=%d action=%s",
                        run.run_id,
                        step_idx,
                        attempt,
                        llm_result.action,
                    )
                    break
                correction_hint = hint
                self.run_store.mark_step_retry(run, step_idx, attempt, hint or "validation failed")
                if attempt >= self.brain.reflector.max_retries:
                    self.run_store.mark_step_failed(run, step_idx, attempt, hint or "validation failed")
                    logger.warning(
                        "[ClosedLoopAgent] step_failed run_id=%s step_idx=%d attempt=%d reason=%s",
                        run.run_id,
                        step_idx,
                        attempt,
                        hint,
                    )
                    break

            if run.steps[step_idx].status == "failed":
                logger.warning("[ClosedLoopAgent] abort_remaining_steps run_id=%s failed_step=%d", run.run_id, step_idx)
                break

        has_failed = any(step.status == "failed" for step in run.steps)
        self.run_store.mark_run_finished(run, status="failed" if has_failed else "completed")
        self.run_store.mark_run_result(run, final_response)
        logger.info(
            "[ClosedLoopAgent] execute_done run_id=%s final_status=%s final_action=%s",
            run.run_id,
            "failed" if has_failed else "completed",
            final_response.action if final_response else "none",
        )
        final = final_response or AIResponse(action="chat", content="No execution output")
        final.run = self.run_store.get(run.run_id)
        return final

    def _inject_context(
        self,
        messages: list[ChatMessage],
        context_text: str,
        step_goal: str,
        correction_hint: str | None,
    ) -> list[ChatMessage]:
        if not messages:
            return [ChatMessage(role="user", content="请根据上下文执行任务。")]

        cloned = [ChatMessage(role=m.role, content=m.content, chat_only=m.chat_only) for m in messages]
        for idx in range(len(cloned) - 1, -1, -1):
            if cloned[idx].role != "user":
                continue
            payload = (
                f"{cloned[idx].content}\n\n"
                f"[StepGoal]\n{step_goal}\n\n"
                f"[StructuredContext]\n{context_text or '(empty)'}"
            )
            if correction_hint:
                payload += f"\n\n[RetryHint]\n{correction_hint}"
            cloned[idx].content = payload
            logger.info(
                "[ClosedLoopAgent] context_injected step_goal=%s context_chars=%d retry_hint=%s",
                step_goal,
                len(context_text or ""),
                bool(correction_hint),
            )
            break
        return cloned
