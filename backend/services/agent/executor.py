from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import shlex
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
            error_text: str | None = None
            if action.type in {ActionType.RUN_COMMAND, ActionType.RUN_TESTS, ActionType.RUN_LINT, ActionType.RUN_BUILD}:
                exit_code = output.get("exit_code") if isinstance(output, dict) else None
                if isinstance(exit_code, int) and exit_code != 0:
                    status = "failed"
                    stderr = str(output.get("stderr") or "").strip() if isinstance(output, dict) else ""
                    error_text = f"命令执行失败 (exit={exit_code})"
                    if stderr:
                        error_text = f"{error_text}: {stderr[:300]}"
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
                    error=error_text,
                    started_at=started,
                    ended_at=ended,
                ),
                file_changes=file_changes,
                assistant_message=assistant_message or error_text,
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
        if action.type == ActionType.READ_FILE_RANGES:
            return self._read_file_ranges(action), [], None, None, False
        if action.type == ActionType.SEARCH_CODE:
            return self._search_code(action), [], None, None, False
        if action.type == ActionType.EXTRACT_SYMBOLS:
            return self._extract_symbols(action), [], None, None, False
        if action.type == ActionType.ANALYZE_DEPENDENCIES:
            return self._analyze_dependencies(action), [], None, None, False
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
        file_stats: list[dict[str, Any]] = []
        dirs: set[str] = set()
        sampled_total_lines = 0
        for path in root.rglob("*"):
            rel = str(path.relative_to(root))
            if self._ignored(rel):
                continue
            if path.is_dir():
                dirs.add(rel)
                continue
            files.append(rel)
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
                line_count = len(text.splitlines())
                sampled_total_lines += line_count
                file_stats.append({"path": rel, "line_count": line_count, "chars": len(text)})
            except Exception as err:
                file_stats.append({"path": rel, "line_count": None, "error": str(err)})
            if len(files) >= limit:
                break
        return {
            "root": str(root),
            "files": files,
            "file_stats": file_stats,
            "file_count": len(files),
            "dir_count": len(dirs),
            "sampled_total_lines": sampled_total_lines,
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
        max_chars = int(action.input.get("max_chars", 12000))
        max_total_chars = int(action.input.get("max_total_chars", 60000))
        limit_files = int(action.input.get("limit_files", action.input.get("limit", 8)))
        results = []
        total_returned_chars = 0
        omitted_files_count = max(0, len(paths) - max(0, limit_files))
        truncated_by_budget = False
        for path in paths[: max(0, limit_files)]:
            try:
                content = file_service.read_file(path).content
                remaining = max_total_chars - total_returned_chars
                if remaining <= 0:
                    truncated_by_budget = True
                    omitted_files_count += 1
                    continue
                allowed_chars = min(max_chars, remaining)
                text = content[:allowed_chars]
                truncated = len(content) > len(text)
                content_truncated_by_budget = remaining < max_chars and len(content) > len(text)
                total_returned_chars += len(text)
                results.append(
                    {
                        "path": path,
                        "chars": len(content),
                        "content": text,
                        "content_truncated": truncated,
                        "content_truncated_by_budget": content_truncated_by_budget,
                        "returned_chars": len(text),
                    }
                )
            except Exception as err:
                results.append({"path": path, "error": str(err)})
        return {
            "files": results,
            "file_count_requested": len(paths),
            "file_count_returned": len(results),
            "limit_files": max(0, limit_files),
            "max_chars": max_chars,
            "max_total_chars": max_total_chars,
            "total_returned_chars": total_returned_chars,
            "omitted_files_count": omitted_files_count,
            "truncated_by_budget": truncated_by_budget,
        }

    def _read_file_ranges(self, action: ActionSpec) -> dict[str, Any]:
        raw_items = action.input.get("items") or action.input.get("ranges") or []
        if not isinstance(raw_items, list) or not raw_items:
            return {"ranges": [], "reason": "no_ranges"}

        context_before = int(action.input.get("context_before", 40))
        context_after = int(action.input.get("context_after", 40))
        max_total_chars = int(action.input.get("max_total_chars", 60000))
        max_items = int(action.input.get("max_items", 40))

        ranges: list[dict[str, Any]] = []
        total_returned_chars = 0
        truncated_by_budget = False
        omitted_ranges_count = max(0, len(raw_items) - max(0, max_items))

        for item in raw_items[: max(0, max_items)]:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path") or item.get("file_path") or "").strip()
            if not path:
                continue
            start_line = int(item.get("start_line", item.get("line", 1)))
            end_line = int(item.get("end_line", start_line))
            if start_line < 1:
                start_line = 1
            if end_line < start_line:
                end_line = start_line

            try:
                content = file_service.read_file(path).content
            except Exception as err:
                ranges.append({"path": path, "error": str(err)})
                continue

            lines = content.splitlines()
            total_lines = len(lines)
            if total_lines == 0:
                ranges.append(
                    {
                        "path": path,
                        "start_line": start_line,
                        "end_line": end_line,
                        "effective_start": 1,
                        "effective_end": 0,
                        "line_count": 0,
                        "content": "",
                        "returned_chars": 0,
                    }
                )
                continue

            effective_start = max(1, start_line - context_before)
            effective_end = min(total_lines, end_line + context_after)
            segment = "\n".join(lines[effective_start - 1:effective_end])

            remaining = max_total_chars - total_returned_chars
            if remaining <= 0:
                truncated_by_budget = True
                omitted_ranges_count += 1
                continue

            returned = segment[:remaining]
            if len(returned) < len(segment):
                truncated_by_budget = True
            total_returned_chars += len(returned)

            ranges.append(
                {
                    "path": path,
                    "start_line": start_line,
                    "end_line": end_line,
                    "effective_start": effective_start,
                    "effective_end": effective_end,
                    "line_count": max(0, effective_end - effective_start + 1),
                    "content": returned,
                    "returned_chars": len(returned),
                    "content_truncated_by_budget": len(returned) < len(segment),
                }
            )

        return {
            "ranges": ranges,
            "range_count_requested": len(raw_items),
            "range_count_returned": len(ranges),
            "context_before": context_before,
            "context_after": context_after,
            "max_total_chars": max_total_chars,
            "total_returned_chars": total_returned_chars,
            "omitted_ranges_count": omitted_ranges_count,
            "truncated_by_budget": truncated_by_budget,
        }

    def _search_code(self, action: ActionSpec) -> dict[str, Any]:
        keyword = str(action.input.get("query") or "").strip()
        raw_paths = action.input.get("paths") or []
        raw_root = str(action.input.get("root") or "").strip()
        regex_raw = action.input.get("regex", False)
        limit = int(action.input.get("limit", 50))
        if not keyword:
            return {"query": "", "matches": [], "reason": "empty_query"}
        if limit <= 0:
            return {"query": keyword, "matches": [], "reason": "invalid_limit"}

        workspace_root = Path(file_service.get_workspace_root()).resolve()
        search_root = workspace_root
        if raw_root:
            root_candidate = Path(raw_root)
            if not root_candidate.is_absolute():
                root_candidate = workspace_root / root_candidate
            search_root = root_candidate.resolve()
            try:
                search_root.relative_to(workspace_root)
            except ValueError:
                return {
                    "query": keyword,
                    "matches": [],
                    "reason": "root_outside_workspace",
                    "workspace_root": str(workspace_root),
                    "root": str(search_root),
                }
            if not search_root.exists():
                return {"query": keyword, "matches": [], "reason": "root_not_found", "root": str(search_root)}
            if not search_root.is_dir():
                return {"query": keyword, "matches": [], "reason": "root_not_dir", "root": str(search_root)}

        regex = False
        if isinstance(regex_raw, bool):
            regex = regex_raw
        elif isinstance(regex_raw, str):
            regex = regex_raw.strip().lower() in {"1", "true", "yes", "on"}

        try:
            pattern = re.compile(keyword if regex else re.escape(keyword), re.IGNORECASE)
        except re.error as err:
            return {"query": keyword, "matches": [], "reason": f"invalid_regex: {err}", "regex": True}

        path_inputs: list[str]
        if isinstance(raw_paths, str):
            path_inputs = [raw_paths]
        elif isinstance(raw_paths, list):
            path_inputs = [str(p) for p in raw_paths if p]
        else:
            path_inputs = []

        candidates: list[Path] = []
        path_warnings: list[str] = []
        if path_inputs:
            for raw_path in path_inputs:
                p = Path(raw_path)
                target = (search_root / p).resolve() if not p.is_absolute() else p.resolve()
                try:
                    target.relative_to(search_root)
                except ValueError:
                    path_warnings.append(f"skip_outside_root:{raw_path}")
                    continue
                if not target.exists():
                    path_warnings.append(f"skip_not_found:{raw_path}")
                    continue
                if target.is_file():
                    candidates.append(target)
                    continue
                if target.is_dir():
                    candidates.extend([sub for sub in target.rglob("*") if sub.is_file()])
        else:
            candidates = [p for p in search_root.rglob("*") if p.is_file()]

        matches: list[dict[str, Any]] = []
        for file_path in candidates:
            try:
                rel = str(file_path.resolve().relative_to(workspace_root))
            except ValueError:
                path_warnings.append(f"skip_unresolvable:{str(file_path)}")
                continue

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
                        return {
                            "query": keyword,
                            "regex": regex,
                            "root": str(search_root),
                            "matches": matches,
                            "warnings": path_warnings[:20],
                        }
        return {
            "query": keyword,
            "regex": regex,
            "root": str(search_root),
            "matches": matches,
            "warnings": path_warnings[:20],
        }

    def _extract_symbols(self, action: ActionSpec) -> dict[str, Any]:
        import ast

        paths = action.input.get("paths") or []
        if not paths:
            return {"ast": [], "reason": "no_paths"}
        root = Path(file_service.get_workspace_root())
        ast_summaries: list[dict[str, Any]] = []
        for path in paths[:50]:
            target = root / path
            try:
                text = target.read_text(encoding="utf-8", errors="replace")
            except Exception as err:
                ast_summaries.append({"path": path, "error": str(err)})
                continue
            suffix = target.suffix.lower()
            if suffix == ".py":
                try:
                    tree = ast.parse(text)
                except Exception as err:
                    ast_summaries.append({"path": path, "error": f"ast_parse_failed: {err}"})
                    continue

                imports: list[dict[str, Any]] = []
                top_level: list[dict[str, Any]] = []
                counts = {"imports": 0, "classes": 0, "functions": 0, "async_functions": 0}
                for node in tree.body:
                    if isinstance(node, (ast.Import, ast.ImportFrom)):
                        counts["imports"] += 1
                        import_stmt = ""
                        if isinstance(node, ast.Import):
                            names = []
                            for alias in node.names:
                                alias_text = alias.name
                                if alias.asname:
                                    alias_text += f" as {alias.asname}"
                                names.append(alias_text)
                            import_stmt = f"import {', '.join(names)}"
                        else:
                            module = "." * int(getattr(node, "level", 0)) + str(node.module or "")
                            names = []
                            for alias in node.names:
                                alias_text = alias.name
                                if alias.asname:
                                    alias_text += f" as {alias.asname}"
                                names.append(alias_text)
                            import_stmt = f"from {module} import {', '.join(names)}"
                        imports.append({"line": int(getattr(node, "lineno", 1)), "stmt": import_stmt})
                    elif isinstance(node, ast.ClassDef):
                        counts["classes"] += 1
                        if len(top_level) < 30:
                            top_level.append({"kind": "class", "name": node.name, "line": int(getattr(node, "lineno", 1))})
                    elif isinstance(node, ast.FunctionDef):
                        counts["functions"] += 1
                        if len(top_level) < 30:
                            top_level.append({"kind": "function", "name": node.name, "line": int(getattr(node, "lineno", 1))})
                    elif isinstance(node, ast.AsyncFunctionDef):
                        counts["async_functions"] += 1
                        if len(top_level) < 30:
                            top_level.append({"kind": "async_function", "name": node.name, "line": int(getattr(node, "lineno", 1))})

                ast_summaries.append(
                    {
                        "path": path,
                        "language": "python",
                        "summary": counts,
                        "imports": imports,
                        "top_level": top_level,
                    }
                )
            else:
                lines = text.splitlines()
                imports: list[dict[str, Any]] = []
                import_patterns = [
                    re.compile(r"^\s*import\b.+"),
                    re.compile(r"^\s*from\s+.+\s+import\s+.+"),
                    re.compile(r"^\s*const\s+.+=\s*require\(.+\)"),
                    re.compile(r"^\s*export\s+.+\s+from\s+.+"),
                ]
                for idx, line in enumerate(lines, start=1):
                    stripped = line.strip()
                    if not stripped:
                        continue
                    if any(pat.search(stripped) for pat in import_patterns):
                        imports.append({"line": idx, "stmt": stripped})
                compact_nodes: list[dict[str, Any]] = []
                pat = re.compile(r"^\s*(export\s+)?(async\s+)?(function|class)\s+([A-Za-z_][\w]*)")
                for idx, line in enumerate(lines, start=1):
                    m = pat.search(line)
                    if not m:
                        continue
                    if len(compact_nodes) >= 30:
                        break
                    compact_nodes.append(
                        {
                            "kind": "function" if m.group(3) == "function" else "class",
                            "name": m.group(4),
                            "line": idx,
                        }
                    )
                ast_summaries.append(
                    {
                        "path": path,
                        "language": "generic",
                        "summary": {"imports": len(imports), "nodes": len(compact_nodes)},
                        "imports": imports,
                        "top_level": compact_nodes,
                    }
                )
        return {"ast": ast_summaries}

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

    def _propose_subplan(self, action: ActionSpec) -> dict[str, Any]:
        steps = action.input.get("steps") or []
        return {"steps": steps, "step_count": len(steps)}

    def _run_command(self, action: ActionSpec) -> dict[str, Any]:
        command = str(action.input.get("command") or "").strip()
        if not command:
            return {"command": "", "exit_code": 1, "stderr": "empty command"}
        workspace_root = Path(file_service.get_workspace_root()).resolve()
        raw_cwd = str(action.input.get("cwd") or "").strip()
        run_cwd = workspace_root
        if raw_cwd:
            cwd_candidate = Path(raw_cwd)
            if not cwd_candidate.is_absolute():
                cwd_candidate = workspace_root / cwd_candidate
            run_cwd = cwd_candidate.resolve()
            try:
                run_cwd.relative_to(workspace_root)
            except ValueError:
                return {
                    "command": command,
                    "cwd": str(run_cwd),
                    "exit_code": 1,
                    "stderr": (
                        f"cwd is outside workspace: {run_cwd}. "
                        f"workspace_root={workspace_root}"
                    ),
                }
            if not run_cwd.exists():
                return {
                    "command": command,
                    "cwd": str(run_cwd),
                    "exit_code": 1,
                    "stderr": f"cwd not found: {run_cwd}",
                }
            if not run_cwd.is_dir():
                return {
                    "command": command,
                    "cwd": str(run_cwd),
                    "exit_code": 1,
                    "stderr": f"cwd is not a directory: {run_cwd}",
                }
        precheck = self._precheck_interactive_command(command)
        if precheck:
            return precheck
        env = os.environ.copy()
        env["CI"] = "1"
        env["DEBIAN_FRONTEND"] = "noninteractive"
        env["npm_config_yes"] = "true"
        timeout_sec = int(action.timeout_sec or 120)
        try:
            proc = subprocess.run(
                command,
                cwd=str(run_cwd),
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout_sec,
                stdin=subprocess.DEVNULL,
                env=env,
            )
            return {
                "command": command,
                "cwd": str(run_cwd),
                "exit_code": proc.returncode,
                "stdout": (proc.stdout or "")[:6000],
                "stderr": (proc.stderr or "")[:4000],
            }
        except subprocess.TimeoutExpired as err:
            return {
                "command": command,
                "cwd": str(run_cwd),
                "exit_code": 124,
                "stdout": str(err.stdout or "")[:6000],
                "stderr": (
                    f"Command timed out after {timeout_sec} seconds. "
                    "可能是命令需要交互输入（选择/确认）。请改用非交互参数，或拆分为明确步骤。"
                ),
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
            content = self._extract_write_content(path=path, llm_resp=llm_resp)
            llm_call = llm_resp.llm_call
        else:
            llm_call = None

        if content is None:
            hint = ""
            if instruction:
                hint = "（模型未返回 file_content/changes，且内容解析失败）"
            raise ValueError(f"write action missing content{hint}")

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

    def _extract_write_content(self, path: str, llm_resp: AIResponse) -> str | None:
        if llm_resp.file_content is not None:
            return str(llm_resp.file_content)

        if llm_resp.changes:
            matched = self._find_change_content(path, llm_resp.changes)
            if matched is not None:
                return matched

        raw = (llm_resp.content or "").strip()
        if not raw:
            return None

        parsed = self._parse_possible_json(raw)
        if isinstance(parsed, dict):
            file_content = parsed.get("file_content")
            if file_content is not None:
                return str(file_content)
            changes = parsed.get("changes")
            if isinstance(changes, list):
                matched = self._find_change_content(path, changes)
                if matched is not None:
                    return matched

        code_block = self._extract_single_code_block(raw)
        if code_block is not None:
            return code_block

        return None

    def _find_change_content(self, path: str, changes: list[Any]) -> str | None:
        target = Path(path).as_posix()
        for item in changes:
            if not isinstance(item, (dict, FileChange)):
                continue
            file_path = item.file_path if isinstance(item, FileChange) else item.get("file_path")
            file_content = item.file_content if isinstance(item, FileChange) else item.get("file_content")
            if file_content is None:
                continue
            if not file_path:
                continue
            candidate = Path(str(file_path)).as_posix()
            if candidate == target:
                return str(file_content)
        return None

    def _parse_possible_json(self, raw: str) -> dict[str, Any] | None:
        text = raw.strip()
        if not text:
            return None

        fence_match = re.search(r"```json\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
        candidates: list[str] = []
        if fence_match:
            candidates.append(fence_match.group(1).strip())

        candidates.append(text)
        brace_match = re.search(r"\{[\s\S]*\}", text)
        if brace_match:
            candidates.append(brace_match.group(0).strip())

        seen: set[str] = set()
        for cand in candidates:
            if not cand or cand in seen:
                continue
            seen.add(cand)
            try:
                obj = json.loads(cand)
                if isinstance(obj, dict):
                    return obj
            except Exception:
                continue
        return None

    def _extract_single_code_block(self, raw: str) -> str | None:
        blocks = re.findall(r"```(?:[\w+-]+)?\s*\n?([\s\S]*?)\n?```", raw)
        if len(blocks) != 1:
            return None
        body = blocks[0].strip("\n")
        return body if body else None

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

    def _precheck_interactive_command(self, command: str) -> dict[str, Any] | None:
        try:
            tokens = shlex.split(command)
        except Exception:
            tokens = command.strip().split()
        if not tokens:
            return None

        # Guard common interactive scaffold commands in non-empty target directories.
        lower = [t.lower() for t in tokens]
        is_vite_scaffold = (
            ("npm" in lower and ("create" in lower or "init" in lower) and any("vite" in t for t in lower))
            or ("npx" in lower and any("create-vite" in t for t in lower))
        )
        if not is_vite_scaffold:
            return None

        target: str | None = None
        if "npx" in lower:
            npx_idx = lower.index("npx")
            for tok in tokens[npx_idx + 1:]:
                if tok.startswith("-"):
                    continue
                if "create-vite" in tok.lower():
                    continue
                target = tok
                break
        elif "npm" in lower and ("create" in lower or "init" in lower):
            npm_idx = lower.index("npm")
            for tok in tokens[npm_idx + 1:]:
                ltok = tok.lower()
                if ltok in {"create", "init"} or ltok.startswith("vite"):
                    continue
                if tok.startswith("-"):
                    continue
                target = tok
                break

        if not target:
            return None

        root = Path(file_service.get_workspace_root())
        target_path = (root / target).resolve() if target not in {".", "./"} else root
        try:
            non_empty = target_path.exists() and target_path.is_dir() and any(target_path.iterdir())
        except Exception:
            non_empty = False
        if non_empty:
            return {
                "command": command,
                "exit_code": 2,
                "stdout": "",
                "stderr": (
                    f"目标目录 `{target}` 非空，脚手架命令很可能进入交互选择。"
                    "请改用新目录，或先清空目标目录后再执行。"
                ),
            }
        return None
