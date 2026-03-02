from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.models.schemas import AIRequestSnapshot, ActionExecutionRecord, ActionType
from backend.services import file_service


class ContextSnapshotBuilder:
    """Build compact context snapshot for planner iterations."""

    def build(
        self,
        req: AIRequestSnapshot,
        action_history: list[ActionExecutionRecord],
        max_files: int = 120,
    ) -> dict[str, Any]:
        return {
            "workspace": self._workspace_summary(max_files=max_files),
            "current_file": self._current_file_summary(req),
            "snippets": self._snippet_summary(req),
            "history": self._history_summary(action_history),
        }

    def _workspace_summary(self, max_files: int) -> dict[str, Any]:
        root = Path(file_service.get_workspace_root())
        files: list[str] = []
        total = 0
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            rel = str(path.relative_to(root))
            if self._ignored(rel):
                continue
            total += 1
            if len(files) < max_files:
                files.append(rel)
        return {
            "root": str(root),
            "file_count": total,
            "sample_files": files,
        }

    def _current_file_summary(self, req: AIRequestSnapshot) -> dict[str, Any]:
        file_path = req.current_file or req.file_path
        if not file_path:
            return {"file": None, "chars": 0, "reason": "no_target_file"}
        try:
            content = req.current_code if req.current_file == file_path and req.current_code is not None else file_service.read_file(file_path).content
            return {
                "file": file_path,
                "chars": len(content),
                "preview": content[:1200],
            }
        except Exception:
            return {"file": file_path, "chars": 0, "reason": "file_not_readable"}

    def _snippet_summary(self, req: AIRequestSnapshot) -> dict[str, Any]:
        snippets = req.snippets or []
        return {
            "count": len(snippets),
            "paths": [sn.file_path for sn in snippets[:30]],
            "chars": sum(len(sn.content) for sn in snippets),
        }

    def _history_summary(self, action_history: list[ActionExecutionRecord]) -> dict[str, Any]:
        completed = 0
        failed = 0
        type_count: dict[str, int] = {}
        recent: list[dict[str, Any]] = []
        for rec in action_history:
            if rec.status == "completed":
                completed += 1
            elif rec.status in {"failed", "blocked"}:
                failed += 1
            type_count[rec.action_type.value] = type_count.get(rec.action_type.value, 0) + 1
            if len(recent) < 20:
                output = rec.output
                output_for_planner: Any = output
                if rec.action_type.value == ActionType.READ_FILES.value and isinstance(output, dict):
                    files = output.get("files")
                    if isinstance(files, list):
                        compact_files: list[dict[str, Any]] = []
                        for item in files[:20]:
                            if not isinstance(item, dict):
                                continue
                            copied = dict(item)
                            content = copied.get("content")
                            if isinstance(content, str) and len(content) > 20000:
                                copied["content"] = content[:20000]
                                copied["content_truncated_by_context"] = True
                            compact_files.append(copied)
                        output_for_planner = {"files": compact_files}
                elif isinstance(output, str) and len(output) > 20000:
                    output_for_planner = output[:20000]
                elif isinstance(output, dict):
                    output_for_planner = output
                recent.append(
                    {
                        "iteration": rec.iteration,
                        "action_id": rec.action_id,
                        "type": rec.action_type.value,
                        "status": rec.status,
                        "error": rec.error,
                        "output": output_for_planner,
                    }
                )
        return {
            "completed": completed,
            "failed": failed,
            "action_type_count": type_count,
            "recent": recent,
            "has_write": any(r.action_type in {ActionType.CREATE_FILE, ActionType.UPDATE_FILE, ActionType.APPLY_PATCH} for r in action_history),
        }

    def _ignored(self, rel_path: str) -> bool:
        parts = set(rel_path.split("/"))
        if parts.intersection({".git", "node_modules", "dist", "build", "__pycache__", ".idea"}):
            return True
        suffix = Path(rel_path).suffix.lower()
        return suffix in {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".lock", ".mp4", ".zip"}
