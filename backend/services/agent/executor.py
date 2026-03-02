from __future__ import annotations

import difflib
import hashlib
import re
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.models.schemas import (
    AIRequestSnapshot,
    AIResponse,
    ActionExecutionRecord,
    ActionSpec,
    ActionType,
    ChatMessage,
    FileChange,
)
from backend.services import ai_service, file_service


@dataclass
class ActionExecutionOutcome:
    record: ActionExecutionRecord
    file_changes: list[FileChange] = field(default_factory=list)
    assistant_message: str | None = None
    final_answer: str | None = None
    blocked: bool = False


class ActionExecutor:
    """Execute action items and return normalized outcomes."""

    async def execute(
        self,
        req: AIRequestSnapshot,
        action: ActionSpec,
        iteration: int,
        history: list[ActionExecutionRecord],
    ) -> ActionExecutionOutcome:
        started = datetime.utcnow().isoformat()
        try:
            output, file_changes, assistant_message, final_answer, blocked = await self._dispatch(req, action, history)
            status = "blocked" if blocked else "completed"
            if blocked and action.type in {ActionType.ASK_USER, ActionType.REQUEST_APPROVAL}:
                status = "waiting_user"
            ended = datetime.utcnow().isoformat()
            return ActionExecutionOutcome(
                record=ActionExecutionRecord(
                    iteration=iteration,
                    action_id=action.id,
                    action_type=action.type,
                    status=status,
                    title=action.title,
                    reason=action.reason,
                    input=action.input,
                    output=output,
                    artifacts=action.artifacts,
                    started_at=started,
                    ended_at=ended,
                ),
                file_changes=file_changes,
                assistant_message=assistant_message,
                final_answer=final_answer,
                blocked=blocked,
            )
        except Exception as err:
            ended = datetime.utcnow().isoformat()
            return ActionExecutionOutcome(
                record=ActionExecutionRecord(
                    iteration=iteration,
                    action_id=action.id,
                    action_type=action.type,
                    status="failed",
                    title=action.title,
                    reason=action.reason,
                    input=action.input,
                    output={},
                    artifacts=action.artifacts,
                    error=str(err),
                    started_at=started,
                    ended_at=ended,
                ),
                assistant_message=f"动作执行失败: {action.title} ({err})",
            )

    async def _dispatch(
        self,
        req: AIRequestSnapshot,
        action: ActionSpec,
        history: list[ActionExecutionRecord],
    ) -> tuple[dict[str, Any], list[FileChange], str | None, str | None, bool]:
        if action.type == ActionType.SCAN_WORKSPACE:
            return self._scan_workspace(action), [], None, None, False
        if action.type == ActionType.READ_FILES:
            return self._read_files(action), [], None, None, False
        if action.type == ActionType.SEARCH_CODE:
            return self._search_code(action), [], None, None, False
        if action.type == ActionType.EXTRACT_SYMBOLS:
            return self._extract_symbols(action), [], None, None, False
        if action.type == ActionType.ANALYZE_DEPENDENCIES:
            return self._analyze_dependencies(action), [], None, None, False
        if action.type == ActionType.SUMMARIZE_CONTEXT:
            return self._summarize_context(history), [], None, None, False
        if action.type == ActionType.PROPOSE_SUBPLAN:
            return self._propose_subplan(action), [], None, None, False
        if action.type in {ActionType.RUN_COMMAND, ActionType.RUN_TESTS, ActionType.RUN_LINT, ActionType.RUN_BUILD}:
            return self._run_command(action), [], None, None, False
        if action.type in {ActionType.CREATE_FILE, ActionType.UPDATE_FILE, ActionType.APPLY_PATCH}:
            out, changes = await self._write_file_action(req, action)
            return out, changes, None, None, False
        if action.type == ActionType.DELETE_FILE:
            return self._delete_file(action), [], None, None, False
        if action.type == ActionType.MOVE_FILE:
            return self._move_file(action), [], None, None, False
        if action.type == ActionType.VALIDATE_RESULT:
            out = await self._validate_result(req, history)
            return out, [], None, None, False
        if action.type == ActionType.ASK_USER:
            question = str(action.input.get("question") or "需要你补充信息后才能继续。")
            return {"question": question}, [], question, None, True
        if action.type == ActionType.REQUEST_APPROVAL:
            prompt = str(action.input.get("prompt") or "该动作需要你确认是否继续执行。")
            return {"approval_prompt": prompt}, [], prompt, None, True
        if action.type == ActionType.FINAL_ANSWER:
            content = str(action.response.get("content") or "任务已完成。")
            return {"content": content}, [], content, content, False
        if action.type == ActionType.REPORT_BLOCKER:
            reason = str(action.input.get("reason") or action.reason or "执行受阻")
            return {"reason": reason}, [], reason, None, True
        raise ValueError(f"Unsupported action type: {action.type}")

    def _scan_workspace(self, action: ActionSpec) -> dict[str, Any]:
        limit = int(action.input.get("limit", 200))
        root = Path(file_service.get_workspace_root())
        files: list[str] = []
        dirs: set[str] = set()
        for path in root.rglob("*"):
            rel = str(path.relative_to(root))
            if self._ignored(rel):
                continue
            if path.is_dir():
                dirs.add(rel)
                continue
            files.append(rel)
            if len(files) >= limit:
                break
        return {
            "root": str(root),
            "files": files,
            "file_count": len(files),
            "dir_count": len(dirs),
        }

    def _read_files(self, action: ActionSpec) -> dict[str, Any]:
        raw_paths = (
            action.input.get("paths")
            or action.input.get("file_paths")
            or action.input.get("files")
            or action.input.get("targets")
            or []
        )
        if isinstance(raw_paths, str):
            paths = [raw_paths]
        elif isinstance(raw_paths, list):
            paths = [str(p) for p in raw_paths if p]
        else:
            paths = []
        max_chars = int(action.input.get("max_chars", 120000))
        results = []
        for path in paths[:50]:
            try:
                content = file_service.read_file(path).content
                truncated = len(content) > max_chars
                text = content[:max_chars]
                results.append(
                    {
                        "path": path,
                        "chars": len(content),
                        "content": text,
                        "content_truncated": truncated,
                        "returned_chars": len(text),
                    }
                )
            except Exception as err:
                results.append({"path": path, "error": str(err)})
        return {"files": results}

    def _search_code(self, action: ActionSpec) -> dict[str, Any]:
        keyword = str(action.input.get("query") or "").strip()
        paths = action.input.get("paths") or []
        limit = int(action.input.get("limit", 50))
        if not keyword:
            return {"query": "", "matches": [], "reason": "empty_query"}

        root = Path(file_service.get_workspace_root())
        candidates: list[Path]
        if paths:
            candidates = [root / p for p in paths]
        else:
            candidates = [p for p in root.rglob("*") if p.is_file()]
        matches: list[dict[str, Any]] = []
        pattern = re.compile(re.escape(keyword), re.IGNORECASE)
        for file_path in candidates:
            rel = str(file_path.relative_to(root)) if file_path.is_absolute() else str(file_path)
            if self._ignored(rel):
                continue
            try:
                text = file_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            for idx, line in enumerate(text.splitlines(), start=1):
                if pattern.search(line):
                    matches.append({"path": rel, "line": idx, "text": line[:240]})
                    if len(matches) >= limit:
                        return {"query": keyword, "matches": matches}
        return {"query": keyword, "matches": matches}

    def _extract_symbols(self, action: ActionSpec) -> dict[str, Any]:
        paths = action.input.get("paths") or []
        if not paths:
            return {"symbols": [], "reason": "no_paths"}
        root = Path(file_service.get_workspace_root())
        pat = re.compile(r"^\s*(def|class|function)\s+([A-Za-z_][\w]*)")
        symbols: list[dict[str, Any]] = []
        for path in paths[:50]:
            target = root / path
            try:
                text = target.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            for idx, line in enumerate(text.splitlines(), start=1):
                m = pat.search(line)
                if m:
                    symbols.append({"path": path, "line": idx, "kind": m.group(1), "name": m.group(2)})
        return {"symbols": symbols}

    def _analyze_dependencies(self, action: ActionSpec) -> dict[str, Any]:
        path = action.input.get("path")
        if not path:
            return {"path": None, "dependencies": [], "reason": "no_target_file"}
        try:
            src = file_service.read_file(path).content
        except Exception:
            return {"path": path, "dependencies": [], "reason": "read_failed"}
        deps: list[str] = []
        patterns = [
            re.compile(r'^\s*import\s+.*?\s+from\s+["\'](.+?)["\']'),
            re.compile(r'^\s*from\s+([A-Za-z0-9_\.]+)\s+import\s+'),
            re.compile(r'^\s*require\(["\'](.+?)["\']\)'),
        ]
        for line in src.splitlines():
            for pat in patterns:
                m = pat.search(line)
                if m:
                    deps.append(m.group(1))
                    break
        return {"path": path, "dependencies": deps[:80], "dependency_count": len(deps)}

    def _summarize_context(self, history: list[ActionExecutionRecord]) -> dict[str, Any]:
        return {
            "history_count": len(history),
            "last_actions": [
                {
                    "id": rec.action_id,
                    "type": rec.action_type.value,
                    "status": rec.status,
                    "error": rec.error,
                }
                for rec in history[-10:]
            ],
        }

    def _propose_subplan(self, action: ActionSpec) -> dict[str, Any]:
        steps = action.input.get("steps") or []
        return {"steps": steps, "step_count": len(steps)}

    def _run_command(self, action: ActionSpec) -> dict[str, Any]:
        command = str(action.input.get("command") or "").strip()
        if not command:
            return {"command": "", "exit_code": 1, "stderr": "empty command"}
        proc = subprocess.run(
            command,
            cwd=file_service.get_workspace_root(),
            shell=True,
            capture_output=True,
            text=True,
            timeout=int(action.timeout_sec or 120),
        )
        return {
            "command": command,
            "exit_code": proc.returncode,
            "stdout": (proc.stdout or "")[:6000],
            "stderr": (proc.stderr or "")[:4000],
        }

    async def _write_file_action(self, req: AIRequestSnapshot, action: ActionSpec) -> tuple[dict[str, Any], list[FileChange]]:
        path = str(action.input.get("path") or "")
        content = action.input.get("content")
        instruction = action.input.get("instruction") or action.input.get("prompt") or action.reason
        if not path:
            raise ValueError("write action missing path")

        before = ""
        try:
            before = file_service.read_file(path).content
        except Exception:
            before = ""

        if content is None and instruction:
            llm_resp = await ai_service.chat(
                provider=req.provider,
                messages=[
                    ChatMessage(role="user", content=f"请修改文件 {path}。要求: {instruction}"),
                ],
                current_file=path,
                current_code=before,
                snippets=req.snippets,
                chat_only=False,
            )
            content = llm_resp.file_content
            if content is None and llm_resp.changes:
                matched = next((c for c in llm_resp.changes if c.file_path == path), None)
                if matched:
                    content = matched.file_content
            llm_call = llm_resp.llm_call
        else:
            llm_call = None

        if content is None:
            raise ValueError("write action missing content")

        file_service.write_file(path, str(content))
        after = str(content)
        diff = "\n".join(
            difflib.unified_diff(
                before.splitlines(),
                after.splitlines(),
                fromfile=f"a/{path}",
                tofile=f"b/{path}",
                lineterm="",
            )
        )
        change = FileChange(
            file_path=path,
            file_content=after,
            before_content=before,
            after_content=after,
            diff_unified=diff,
            before_hash=hashlib.sha256(before.encode("utf-8")).hexdigest(),
            after_hash=hashlib.sha256(after.encode("utf-8")).hexdigest(),
            write_result="written",
        )
        output = {"path": path, "before_len": len(before), "after_len": len(after)}
        if llm_call:
            output["_llm"] = llm_call
        return (output, [change])

    def _delete_file(self, action: ActionSpec) -> dict[str, Any]:
        path = str(action.input.get("path") or "")
        if not path:
            raise ValueError("delete action missing path")
        file_service.delete_item(path)
        return {"path": path, "deleted": True}

    def _move_file(self, action: ActionSpec) -> dict[str, Any]:
        old_path = str(action.input.get("old_path") or "")
        new_path = str(action.input.get("new_path") or "")
        if not old_path or not new_path:
            raise ValueError("move action missing old_path/new_path")
        file_service.rename_item(old_path, new_path)
        return {"old_path": old_path, "new_path": new_path, "moved": True}

    async def _validate_result(self, req: AIRequestSnapshot, history: list[ActionExecutionRecord]) -> dict[str, Any]:
        failures = [h for h in history if h.status in {"failed", "blocked"}]
        if failures:
            return {
                "satisfied": False,
                "reason": "has_failed_actions",
                "failed_actions": [f"{f.action_id}:{f.action_type.value}" for f in failures[-10:]],
            }
        # Lightweight best-effort validation summary.
        latest = history[-8:]
        summary = "\n".join(f"- {r.action_type.value}: {r.status}" for r in latest)
        prompt = (
            "基于以下执行摘要，判断是否已满足用户诉求。只返回简短结论。\n"
            f"用户诉求: {self._latest_user_query(req)}\n执行摘要:\n{summary}"
        )
        resp = await ai_service.chat(
            provider=req.provider,
            messages=[ChatMessage(role="user", content=prompt)],
            chat_only=True,
            snippets=req.snippets,
        )
        output = {
            "satisfied": True,
            "reason": resp.content[:500],
        }
        if resp.llm_call:
            output["_llm"] = resp.llm_call
        return output

    def _latest_user_query(self, req: AIRequestSnapshot) -> str:
        for msg in reversed(req.messages):
            if msg.role == "user":
                return msg.content
        return ""

    def _ignored(self, rel_path: str) -> bool:
        parts = set(rel_path.split("/"))
        if parts.intersection({".git", "node_modules", "dist", "build", "__pycache__", ".idea"}):
            return True
        suffix = Path(rel_path).suffix.lower()
        return suffix in {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".lock", ".mp4", ".zip"}
