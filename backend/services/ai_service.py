import os
import json
import re
import logging
from datetime import datetime
from backend.models.schemas import (
    AIProvider,
    ChatMessage,
    AIResponse,
    CodeSnippet,
    PlanBlock,
    PlanStep,
    FileChange,
    AIRequestSnapshot,
    ActionBatch,
    ActionBatchDecision,
    ActionExecutionRecord,
    ActionSpec,
    ActionType,
)

logger = logging.getLogger("ai_service")

LOG_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "logs")
os.makedirs(LOG_DIR, exist_ok=True)


def _estimate_tokens_from_messages(messages: list[dict]) -> int:
    total_chars = 0
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        total_chars += len(str(msg.get("content", "")))
    return max(1, total_chars // 4)


def _estimate_tokens_from_text(text: str) -> int:
    return max(1, len(text) // 4)


def _build_llm_call_meta(
    *,
    provider: str,
    model: str,
    messages: list[dict],
    elapsed_ms: int,
    input_tokens: int | None,
    output_tokens: int | None,
    token_source: str,
) -> dict:
    in_tokens = input_tokens if isinstance(input_tokens, int) and input_tokens >= 0 else _estimate_tokens_from_messages(messages)
    out_tokens = output_tokens if isinstance(output_tokens, int) and output_tokens >= 0 else 0
    return {
        "provider": provider,
        "model": model,
        "elapsed_ms": elapsed_ms,
        "prompt_messages": messages,
        "tokens": {
            "input": in_tokens,
            "output": out_tokens,
            "total": in_tokens + out_tokens,
            "source": token_source,
            "estimated": token_source != "provider",
        },
    }


def _log_interaction(
    provider: str,
    model: str,
    messages: list[dict],
    response: str,
    elapsed_ms: int,
    error: str | None = None,
    llm_call: dict | None = None,
):
    """将每次 AI 请求和响应写入日志文件（按日期分文件）。"""
    today = datetime.now().strftime("%Y-%m-%d")
    log_file = os.path.join(LOG_DIR, f"ai_{today}.jsonl")

    record = {
        "timestamp": datetime.now().isoformat(),
        "provider": provider,
        "model": model,
        "elapsed_ms": elapsed_ms,
        "prompt_messages": messages,
        "response": response if not error else None,
        "error": error,
        "llm_call": llm_call,
    }

    try:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:
        logger.warning(f"Failed to write AI log: {e}")

    if error:
        logger.error(f"[{provider}/{model}] error={error} elapsed={elapsed_ms}ms")
    else:
        preview = response[:120].replace("\n", "\\n") + ("..." if len(response) > 120 else "")
        logger.info(f"[{provider}/{model}] ok elapsed={elapsed_ms}ms response_len={len(response)} preview={preview}")

SYSTEM_PROMPT = """你是一个专业的AI编程助手。你可以帮助用户生成代码、修改代码、解答编程问题。

当用户要求你生成或修改文件时，请严格按照以下JSON格式返回（不要添加多余文字）：
```json
{
  "action": "generate" 或 "modify",
  "file_path": "文件路径",
  "file_content": "完整的文件内容",
  "explanation": "简要说明你做了什么"
}
```

如需在一步中修改多个文件，可返回：
```json
{
  "action": "modify",
  "changes": [
    { "file_path": "a.py", "file_content": "..." },
    { "file_path": "b.py", "file_content": "..." }
  ],
  "explanation": "简要说明"
}
```

当用户只是提问或聊天时，直接用普通文字回复即可。

当用户要求进入 planning/规划模式时，请严格按照以下JSON格式返回（不要添加多余文字）：
```json
{
  "action": "plan",
  "plan": {
    "summary": "一句话目标摘要",
    "milestones": ["里程碑1", "里程碑2"],
    "steps": [
      {
        "title": "步骤标题",
        "detail": "具体执行说明",
        "status": "pending",
        "acceptance": "完成标准"
      }
    ],
    "risks": ["风险1", "风险2"]
  },
  "explanation": "对计划的简要说明"
}
```

注意事项：
- 生成的代码要完整、可运行
- 普通修改时返回修改后的完整文件内容
- 当请求包含范围修改要求时，file_content 只返回“指定范围的替换内容”，不要返回整文件
- 当请求是“仅对话模式”时，只做解释与建议，不要返回任何文件修改内容
- 当请求是“planning模式”时，只返回计划，不要返回任何文件修改内容
- 当用户明确说“这几行/这部分/这些片段/就改这里/只改引用”时，视为“片段定向修改”：
  1) 优先只改引用片段对应范围
  2) 不做整文件重构、跨函数大搬移、无关格式化
  3) 若必须改范围外才能成立，不直接改文件，改为自然语言解释需要额外调整的原因与建议
- 当用户未明确要求“只改引用片段”时，引用片段默认仅作为上下文参考，按用户真实意图决定是回答问题还是修改代码
- file_path使用相对路径
- 代码要符合最佳实践，有适当注释"""

PLANNER_SYSTEM_PROMPT = """你是 Nexar 的动作规划器（Planner）。

你必须基于输入上下文，输出下一轮 ActionBatch JSON，严格遵守：
1) 不要写死固定流程，不要假设状态机；你需要根据当前证据自主决定下一批 actions。
2) 每轮先判断“信息是否已足够支撑结论或改动”；若不足，再选择最低成本的取证动作（如 search/read/range/dependency），若足够则收敛到 final_answer 或后续执行动作。
3) 输出必须是可执行、可验证的动作（每个 action 都要有 success_criteria），并在 reason 里说明该动作要消除哪一个不确定点。
4) 信息不足时输出 ask_user / request_approval，不要臆造文件内容；有明确证据后再做结论。
5) 当目标满足时，decision.mode=done，必须输出 final_answer 动作，并在 action.response.content 中给出最终答复文本。
6) 只返回 JSON，不要 Markdown，不要解释文字。
7) 规划时优先结合 conversation_history 与 conversation_summary，不要只看 original_user_query。
8) 控制上下文成本：避免一次性读取大量大文件；优先小范围、可验证、信息增益高的动作；信息增益低时应停止重复读取并切换策略。
9) decision.needs_user_trigger 仅作兼容字段：串行模式下是否等待用户由 ask_user/request_approval 动作决定；decision.mode 为 continue/done/blocked 时 needs_user_trigger 必须为 false。
10) 对 create_file/update_file/apply_patch 动作：input 必须包含 path，且至少包含 content 或 instruction 之一。
11) 对 final_answer 动作：response 必须包含 content（字符串）。
12) 当前阶段目标是“规划与写代码”，禁止输出环境安装/初始化类命令（如 npm/pnpm/yarn install、pip install、create-vite、tailwindcss init 等）；此类步骤留给用户在代码完成后手动执行。
13) search_code 的 input 字段只允许：query, root, paths, regex, limit。禁止输出 patterns/include/file_glob/max_results/case_sensitive 等字段。
14) search_code 的 query 规则：当 regex=false 时，query 必须是字面匹配短语，不允许 OR/AND/NOT、`|` 或正则语法；需要多关键词时拆成多个 search_code 动作。仅 regex=true 时允许 `|`。
15) run_command/run_tests/run_lint/run_build 的 input 字段只允许：command, cwd。cwd 必须是相对 workspace_root 的路径（如 frontend、backend）或 workspace 内绝对路径；禁止 working_directory/workdir/dir/path 等别名。
16) 当 run_command 需要执行 Python 代码片段（尤其包含 async def、多行逻辑、try/except）时，禁止 `python -c "..."` 单行拼接；必须使用 `python3 - <<'PY' ... PY` heredoc 多行脚本。
17) 读取策略选择原则：extract_symbols 用于快速获取文件结构与入口点；read_file_ranges 用于已知命中行附近的定点取证；read_files 仅在需要整文件上下文时使用，并优先针对少量核心文件。
18) extract_symbols 的 input.paths 必须是“文件路径列表”，不要传目录路径；若当前只有目录信息，先用 scan_workspace/search_code 选出候选文件后再调用 extract_symbols。
19) read_file_ranges 的 input 必须使用对象数组：items 或 ranges = [{ "path": "...", "start_line": 10, "end_line": 30 }]；禁止使用 "250-500" 这类字符串区间。

输出格式：
{
  "version": "1.0",
  "iteration": 1,
  "summary": "本轮目标",
  "decision": {
    "mode": "continue|ask_user|done|blocked",
    "reason": "可选",
    "needs_user_trigger": true,
    "satisfaction_score": 0.0
  },
  "actions": [
    {
      "id": "a1",
      "type": "scan_workspace|read_files|read_file_ranges|search_code|extract_symbols|analyze_dependencies|run_command|run_tests|run_lint|run_build|create_file|update_file|delete_file|move_file|apply_patch|validate_result|ask_user|request_approval|final_answer|report_blocker",
      "title": "动作标题",
      "reason": "动作原因",
      "input": {},
      "response": {},
      "depends_on": [],
      "can_parallel": false,
      "priority": 3,
      "timeout_sec": 120,
      "max_retries": 1,
      "success_criteria": ["完成标准"],
      "artifacts": []
    }
  ],
  "acceptance": [],
  "risks": [],
  "next_questions": []
}
"""


def _slice_lines(content: str, start_line: int, end_line: int) -> str:
    lines = content.splitlines()
    if start_line < 1 or end_line < start_line:
        raise ValueError("Invalid range: range_start/range_end must satisfy 1 <= range_start <= range_end")
    if end_line > len(lines):
        raise ValueError(f"Invalid range: file has {len(lines)} lines, but range_end={end_line}")
    return "\n".join(lines[start_line - 1:end_line])


def _build_messages(
    messages: list[ChatMessage],
    current_file: str | None,
    current_code: str | None,
    action: str,
    file_path: str | None,
    snippets: list[CodeSnippet] | None = None,
    chat_only: bool = False,
    planning_mode: bool = False,
    range_start: int | None = None,
    range_end: int | None = None,
) -> list[dict]:
    if action == "modify" and ((range_start is None) != (range_end is None)):
        raise ValueError("range_start and range_end must be provided together")

    built = [{"role": "system", "content": SYSTEM_PROMPT}]

    if current_file and current_code:
        context = f"\n\n[当前打开的文件: {current_file}]\n```\n{current_code}\n```"
    else:
        context = ""

    if action == "generate" and file_path:
        context += f"\n\n[用户要求生成文件: {file_path}，请以JSON格式返回结果]"
    elif action == "modify" and current_file:
        if range_start is not None and range_end is not None:
            if not current_code:
                raise ValueError("Range modify requires current_code")
            selected = _slice_lines(current_code, range_start, range_end)
            context += (
                f"\n\n[用户要求范围修改文件: {current_file}]"
                f"\n[仅修改第 {range_start}-{range_end} 行]"
                "\n[请保持范围外代码不变]"
                "\n[请在 JSON 的 file_content 字段中只返回该行范围的替换内容，不要返回整文件]"
                f"\n[当前范围原始代码]\n```\n{selected}\n```"
            )
        else:
            context += f"\n\n[用户要求修改文件: {current_file}，请以JSON格式返回修改后的完整文件]"

    if chat_only:
        context += (
            "\n\n[当前请求为仅对话模式]"
            "\n[你必须只返回自然语言回答，不得返回可落盘的文件修改结果]"
            "\n[不要返回 action=modify/generate 的 JSON 结构]"
        )
    if planning_mode:
        context += (
            "\n\n[当前请求为 planning 模式]"
            "\n[你必须只输出规划结果，action 必须为 plan]"
            "\n[不得返回可落盘的文件修改结果]"
            "\n[steps 中的 status 统一先用 pending]"
        )

    snippet_focused = _is_snippet_focused_intent(messages) if snippets else False

    if snippets:
        context += "\n\n[用户粘贴的代码片段引用如下，可作为参考上下文]"
        for idx, snippet in enumerate(snippets, start=1):
            context += (
                f"\n\n[片段{idx}: {snippet.file_path} ({snippet.start_line}-{snippet.end_line})]"
                f"\n```\n{snippet.content}\n```"
            )
        if snippet_focused:
            context += (
                "\n\n[用户明确要求修改“这部分/这些片段”，请优先修改引用片段范围；"
                "若确有必要可做最小范围的关联调整]"
            )
        else:
            context += (
                "\n\n[用户未明确要求只改引用片段：这些片段仅用于理解上下文，"
                "你应根据用户意图自行判断修改范围，或仅回答问题]"
            )

    for msg in messages:
        content = msg.content
        if msg.role == "user" and msg == messages[-1]:
            content += context
        built.append({"role": msg.role, "content": content})

    return built


def _latest_user_text(messages: list[ChatMessage]) -> str:
    for msg in reversed(messages):
        if msg.role == "user":
            return msg.content.lower()
    return ""


def _is_snippet_focused_intent(messages: list[ChatMessage]) -> bool:
    text = _latest_user_text(messages)
    focus_terms = (
        "这部分", "这段", "这些片段", "引用部分", "选中部分",
        "this part", "these parts", "selected snippet", "selected part",
    )
    edit_terms = (
        "改", "修改", "重构", "优化", "修复", "调整",
        "modify", "change", "edit", "refactor", "optimize", "fix", "rewrite",
    )
    return any(t in text for t in focus_terms) and any(t in text for t in edit_terms)


def _has_modify_intent(messages: list[ChatMessage]) -> bool:
    text = _latest_user_text(messages)
    modify_hints = (
        "modify", "change", "edit", "refactor", "rewrite", "fix", "optimize",
        "修改", "重构", "优化", "修复", "调整", "改一下", "改成",
    )
    return any(word in text for word in modify_hints)


def _infer_action(
    messages: list[ChatMessage],
    current_file: str | None,
    file_path: str | None,
    snippets: list[CodeSnippet] | None,
    chat_only: bool,
    planning_mode: bool,
    range_start: int | None,
    range_end: int | None,
) -> str:
    if planning_mode:
        return "plan"

    if chat_only:
        return "chat"

    if file_path:
        return "generate"

    if range_start is not None or range_end is not None:
        return "modify"

    if snippets and _has_modify_intent(messages):
        return "modify"

    if current_file and _has_modify_intent(messages):
        return "modify"

    return "chat"


def _parse_ai_response(raw: str, action: str) -> AIResponse:
    json_match = re.search(r'```json\s*\n?(.*?)\n?\s*```', raw, re.DOTALL)
    if not json_match:
        json_match = re.search(r'\{[\s\S]*"action"[\s\S]*\}', raw, re.DOTALL)

    if json_match:
        try:
            text = json_match.group(1) if '```' in json_match.group(0) else json_match.group(0)
            data = json.loads(text)
            plan_data = data.get("plan")
            plan = None
            if isinstance(plan_data, dict):
                steps_data = plan_data.get("steps", [])
                steps: list[PlanStep] = []
                if isinstance(steps_data, list):
                    for step in steps_data:
                        if isinstance(step, dict) and step.get("title"):
                            steps.append(
                                PlanStep(
                                    title=str(step.get("title")),
                                    detail=step.get("detail"),
                                    status=str(step.get("status", "pending")),
                                    acceptance=step.get("acceptance"),
                                )
                            )
                plan = PlanBlock(
                    summary=str(plan_data.get("summary", "")),
                    milestones=[str(x) for x in plan_data.get("milestones", []) if isinstance(x, (str, int, float))],
                    steps=steps,
                    risks=[str(x) for x in plan_data.get("risks", []) if isinstance(x, (str, int, float))],
                )
            changes_data = data.get("changes")
            changes = None
            if isinstance(changes_data, list):
                parsed_changes: list[FileChange] = []
                for item in changes_data:
                    if isinstance(item, dict) and item.get("file_path") and item.get("file_content") is not None:
                        parsed_changes.append(
                            FileChange(
                                file_path=str(item.get("file_path")),
                                file_content=str(item.get("file_content")),
                            )
                        )
                if parsed_changes:
                    changes = parsed_changes

            return AIResponse(
                content=data.get("explanation", raw),
                file_path=data.get("file_path"),
                file_content=data.get("file_content"),
                action=data.get("action", action),
                plan=plan,
                changes=changes,
            )
        except (json.JSONDecodeError, AttributeError):
            pass

    stripped = raw.strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        try:
            data = json.loads(stripped)
            if isinstance(data, dict) and (
                "action" in data
                or "file_content" in data
                or "changes" in data
                or "file_path" in data
                or "plan" in data
            ):
                return _parse_ai_response(f"```json\n{stripped}\n```", action)
        except json.JSONDecodeError:
            pass

    fallback_action = "plan" if action == "plan" else "chat"
    return AIResponse(content=raw, action=fallback_action)


def _find_balanced_json_objects(text: str) -> list[str]:
    candidates: list[str] = []
    start = -1
    depth = 0
    in_str = False
    escape = False
    for i, ch in enumerate(text):
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            continue
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
            continue
        if ch == "}":
            if depth == 0:
                continue
            depth -= 1
            if depth == 0 and start >= 0:
                candidates.append(text[start:i + 1])
                start = -1
    return candidates


def _extract_json_payload(raw: str) -> dict:
    text = (raw or "").strip().replace("\ufeff", "")
    if not text:
        raise ValueError("planner output is empty")

    candidates: list[str] = []
    # 优先 json code fence
    for match in re.finditer(r"```json\s*([\s\S]*?)\s*```", text, re.IGNORECASE):
        candidates.append(match.group(1))
    # 其次任意 code fence
    for match in re.finditer(r"```[\w-]*\s*([\s\S]*?)\s*```", text):
        candidates.append(match.group(1))
    # 整体文本
    candidates.append(text)
    # 以及文本内平衡的大括号对象
    candidates.extend(_find_balanced_json_objects(text))

    seen: set[str] = set()
    normalized_candidates: list[str] = []
    for cand in candidates:
        s = (cand or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        normalized_candidates.append(s)

    for cand in normalized_candidates:
        attempts = [
            cand,
            re.sub(r",\s*([}\]])", r"\1", cand),  # 去掉尾逗号
        ]
        for attempt in attempts:
            try:
                payload = json.loads(attempt)
                if isinstance(payload, dict):
                    return payload
            except Exception:
                continue
    raise ValueError("planner output is not valid JSON")


def _parse_action_batch_response(raw: str, iteration: int) -> ActionBatch:
    payload = _extract_json_payload(raw)
    if not isinstance(payload, dict):
        raise ValueError("planner payload must be object")

    payload.setdefault("version", "1.0")
    payload.setdefault("actions", [])
    payload.setdefault("acceptance", [])
    payload.setdefault("risks", [])
    payload.setdefault("next_questions", [])

    decision = payload.get("decision")
    if isinstance(decision, str):
        payload["decision"] = {
            "mode": decision,
            "needs_user_trigger": True,
        }
    elif isinstance(decision, dict):
        decision.setdefault("needs_user_trigger", True)
    else:
        payload["decision"] = {
            "mode": "ask_user",
            "reason": "missing_decision",
            "needs_user_trigger": True,
        }

    actions = payload.get("actions")
    if isinstance(actions, list):
        normalized_actions = []
        for idx, act in enumerate(actions):
            if not isinstance(act, dict):
                continue
            act = dict(act)
            act.setdefault("id", f"a{idx + 1}")
            act.setdefault("title", act.get("type", "未命名动作"))
            act.setdefault("reason", "planner_output_normalized")
            act.setdefault("input", {})
            act.setdefault("response", {})
            act.setdefault("depends_on", [])
            act.setdefault("can_parallel", False)
            act.setdefault("priority", 3)
            act.setdefault("timeout_sec", 120)
            act.setdefault("max_retries", 1)
            act.setdefault("success_criteria", ["动作可执行并产出结果"])
            act.setdefault("artifacts", [])
            normalized_actions.append(act)
        payload["actions"] = normalized_actions
    else:
        payload["actions"] = []

    normalized_decision = payload.get("decision")
    if isinstance(normalized_decision, dict):
        mode = str(normalized_decision.get("mode") or "").strip().lower()
        has_actions = bool(payload.get("actions"))
        if mode in {"done", "continue", "blocked"}:
            normalized_decision["needs_user_trigger"] = False
        elif mode == "ask_user":
            normalized_decision["needs_user_trigger"] = not has_actions

    payload["iteration"] = iteration
    batch = ActionBatch.model_validate(payload)
    return batch


def _build_history_summary(messages: list[ChatMessage], max_chars: int) -> str:
    if not messages:
        return ""
    parts: list[str] = []
    total = 0
    for msg in messages:
        content = (msg.content or "").replace("\n", " ").strip()
        if not content:
            continue
        entry = f"{msg.role}: {content}"
        if total + len(entry) + (1 if parts else 0) > max_chars:
            remain = max_chars - total - (1 if parts else 0)
            if remain > 20:
                entry = entry[:remain]
                parts.append(entry)
            break
        parts.append(entry)
        total += len(entry) + (1 if parts else 0)
    return "\n".join(parts)


def _extract_key_result_for_planner(action_type: ActionType, output: object) -> str:
    if not isinstance(output, dict):
        text = str(output or "").strip()
        return text[:160] if text else ""

    if action_type == ActionType.SEARCH_CODE:
        matches = output.get("matches")
        if isinstance(matches, list):
            files = sorted({str(m.get("path")) for m in matches if isinstance(m, dict) and m.get("path")})
            return f"hits={len(matches)}, files={len(files)}"
        return "search_done"
    if action_type == ActionType.READ_FILES:
        returned = output.get("file_count_returned")
        chars = output.get("total_returned_chars")
        return f"files={returned}, chars={chars}"
    if action_type == ActionType.READ_FILE_RANGES:
        returned = output.get("range_count_returned")
        chars = output.get("total_returned_chars")
        return f"ranges={returned}, chars={chars}"
    if action_type in {ActionType.RUN_COMMAND, ActionType.RUN_TESTS, ActionType.RUN_LINT, ActionType.RUN_BUILD}:
        code = output.get("exit_code")
        stderr = str(output.get("stderr") or "").strip()
        if stderr:
            return f"exit={code}, err={stderr[:100]}"
        return f"exit={code}"
    if action_type in {ActionType.CREATE_FILE, ActionType.UPDATE_FILE, ActionType.APPLY_PATCH}:
        path = output.get("path")
        before_len = output.get("before_len")
        after_len = output.get("after_len")
        return f"path={path}, {before_len}->{after_len}"
    if action_type == ActionType.EXTRACT_SYMBOLS:
        ast_items = output.get("ast")
        if isinstance(ast_items, list):
            return f"ast_files={len(ast_items)}"
        return "ast_done"
    if action_type == ActionType.ANALYZE_DEPENDENCIES:
        cnt = output.get("dependency_count")
        return f"deps={cnt}"
    if action_type == ActionType.VALIDATE_RESULT:
        sat = output.get("satisfied")
        reason = str(output.get("reason") or "")
        return f"satisfied={sat}, reason={reason[:80]}"

    keys = [k for k in output.keys() if isinstance(k, str)]
    return ",".join(keys[:5])


def _compact_context_snapshot_for_planner(context_snapshot: dict) -> dict:
    if not isinstance(context_snapshot, dict):
        return {}
    ws = context_snapshot.get("workspace", {}) if isinstance(context_snapshot.get("workspace"), dict) else {}
    cf = context_snapshot.get("current_file", {}) if isinstance(context_snapshot.get("current_file"), dict) else {}
    sn = context_snapshot.get("snippets", {}) if isinstance(context_snapshot.get("snippets"), dict) else {}
    hs = context_snapshot.get("history", {}) if isinstance(context_snapshot.get("history"), dict) else {}

    compact_recent = []
    recent = hs.get("recent")
    if isinstance(recent, list):
        for item in recent[-10:]:
            if not isinstance(item, dict):
                continue
            compact_recent.append(
                {
                    "type": item.get("type"),
                    "status": item.get("status"),
                    "error": item.get("error"),
                }
            )

    return {
        "workspace": {
            "root": ws.get("root"),
            "file_count": ws.get("file_count"),
            "sample_files": (ws.get("sample_files") or [])[:20] if isinstance(ws.get("sample_files"), list) else [],
        },
        "current_file": {
            "file": cf.get("file"),
            "chars": cf.get("chars"),
        },
        "snippets": {
            "count": sn.get("count"),
            "paths": (sn.get("paths") or [])[:20] if isinstance(sn.get("paths"), list) else [],
        },
        "history": {
            "completed": hs.get("completed"),
            "failed": hs.get("failed"),
            "action_type_count": hs.get("action_type_count"),
            "recent": compact_recent,
        },
    }


def _build_planner_brief(
    *,
    original_user_query: str,
    iteration: int,
    conversation_summary: str,
    conversation_history: list[dict],
    history_payload: list[dict],
    runtime_constraints: dict,
    context_snapshot_compact: dict,
) -> str:
    convo_lines: list[str] = []
    for msg in conversation_history[-8:]:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "unknown")
        content = str(msg.get("content") or "").replace("\n", " ").strip()
        if not content:
            continue
        convo_lines.append(f"- {role}: {content[:220]}")

    history_lines: list[str] = []
    for item in history_payload[-12:]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        prefix = f"{title} | " if title else ""
        history_lines.append(
            f"- {prefix}{item.get('action_type')}[{item.get('status')}]: {item.get('key_result') or ''}".strip()
        )

    lines = [
        f"目标: {original_user_query}",
        f"轮次: {iteration}",
        f"运行约束: chat_only={runtime_constraints.get('chat_only')}, force_code_edit={runtime_constraints.get('force_code_edit')}, range=({runtime_constraints.get('range_start')},{runtime_constraints.get('range_end')})",
    ]
    if conversation_summary:
        lines.append(f"历史摘要: {conversation_summary[:600]}")
    if convo_lines:
        lines.append("最近对话:")
        lines.extend(convo_lines)
    if history_lines:
        lines.append("最近动作结果:")
        lines.extend(history_lines)

    ws = context_snapshot_compact.get("workspace", {}) if isinstance(context_snapshot_compact.get("workspace"), dict) else {}
    lines.append(
        f"工作区概况: file_count={ws.get('file_count')}, sample_files={len(ws.get('sample_files') or []) if isinstance(ws.get('sample_files'), list) else 0}"
    )
    return "\n".join(lines)


def _compact_history_output_for_planner(action_type: ActionType, output: object) -> object:
    if not isinstance(output, dict):
        if isinstance(output, str) and len(output) > 4000:
            return output[:4000]
        return output

    if action_type == ActionType.READ_FILES:
        files = output.get("files")
        compact_files: list[dict] = []
        if isinstance(files, list):
            for item in files[:20]:
                if not isinstance(item, dict):
                    continue
                compact_files.append(
                    {
                        "path": item.get("path"),
                        "chars": item.get("chars"),
                        "returned_chars": item.get("returned_chars"),
                        "content_truncated": item.get("content_truncated"),
                        "content_truncated_by_budget": item.get("content_truncated_by_budget"),
                        "content": (str(item.get("content")) if item.get("content") is not None else None),
                        "error": item.get("error"),
                    }
                )
        return {
            "files": compact_files,
            "file_count_requested": output.get("file_count_requested"),
            "file_count_returned": output.get("file_count_returned"),
            "total_returned_chars": output.get("total_returned_chars"),
            "omitted_files_count": output.get("omitted_files_count"),
            "truncated_by_budget": output.get("truncated_by_budget"),
        }

    if action_type == ActionType.READ_FILE_RANGES:
        ranges = output.get("ranges")
        compact_ranges: list[dict] = []
        if isinstance(ranges, list):
            for item in ranges[:30]:
                if not isinstance(item, dict):
                    continue
                compact_ranges.append(
                    {
                        "path": item.get("path"),
                        "start_line": item.get("start_line"),
                        "end_line": item.get("end_line"),
                        "effective_start": item.get("effective_start"),
                        "effective_end": item.get("effective_end"),
                        "line_count": item.get("line_count"),
                        "returned_chars": item.get("returned_chars"),
                        "content_truncated_by_budget": item.get("content_truncated_by_budget"),
                        "content": (str(item.get("content")) if item.get("content") is not None else None),
                        "error": item.get("error"),
                    }
                )
        return {
            "ranges": compact_ranges,
            "range_count_requested": output.get("range_count_requested"),
            "range_count_returned": output.get("range_count_returned"),
            "total_returned_chars": output.get("total_returned_chars"),
            "omitted_ranges_count": output.get("omitted_ranges_count"),
            "truncated_by_budget": output.get("truncated_by_budget"),
        }

    if action_type in {ActionType.RUN_COMMAND, ActionType.RUN_TESTS, ActionType.RUN_LINT, ActionType.RUN_BUILD}:
        return {
            "command": output.get("command"),
            "cwd": output.get("cwd"),
            "exit_code": output.get("exit_code"),
            "stdout": str(output.get("stdout") or "")[:1200],
            "stderr": str(output.get("stderr") or "")[:1200],
        }

    if action_type == ActionType.EXTRACT_SYMBOLS:
        ast_items = output.get("ast")
        compact_ast: list[dict] = []
        if isinstance(ast_items, list):
            for item in ast_items[:20]:
                if not isinstance(item, dict):
                    continue
                compact_ast.append(
                    {
                        "path": item.get("path"),
                        "language": item.get("language"),
                        "summary": item.get("summary"),
                        "imports": item.get("imports"),
                        "top_level": item.get("top_level"),
                        "error": item.get("error"),
                    }
                )
        return {"ast": compact_ast}

    return output


async def call_openai(messages: list[dict]) -> tuple[str, dict]:
    import openai
    import time
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    model = os.getenv("OPENAI_MODEL", "gpt-4o")
    api_key = os.getenv("OPENAI_API_KEY", "")
    
    if not api_key:
        raise ValueError("OPENAI_API_KEY 未配置，请在 backend/.env 文件中设置")
    
    extra_headers = {}
    if "openrouter.ai" in base_url:
        # OpenRouter 需要这些请求头
        extra_headers = {
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "Nexar Code",
        }
        # 验证 API Key 格式（OpenRouter 的 Key 通常以 sk-or-v1- 开头）
        if not api_key.startswith("sk-or-v1-") and not api_key.startswith("sk-or-"):
            logger.warning(f"OpenRouter API Key 格式可能不正确，应以 'sk-or-v1-' 或 'sk-or-' 开头")
    
    client = openai.AsyncOpenAI(
        api_key=api_key,
        base_url=base_url,
        default_headers=extra_headers,
    )
    t0 = time.monotonic()
    try:
        resp = await client.chat.completions.create(model=model, messages=messages, temperature=0.3, max_tokens=8192)
        result = resp.choices[0].message.content or ""
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        usage = getattr(resp, "usage", None)
        input_tokens = getattr(usage, "prompt_tokens", None) if usage is not None else None
        output_tokens = getattr(usage, "completion_tokens", None) if usage is not None else None
        llm_call = _build_llm_call_meta(
            provider="openai",
            model=model,
            messages=messages,
            elapsed_ms=elapsed_ms,
            input_tokens=input_tokens,
            output_tokens=output_tokens if isinstance(output_tokens, int) else _estimate_tokens_from_text(result),
            token_source="provider" if isinstance(input_tokens, int) and isinstance(output_tokens, int) else "estimated",
        )
        _log_interaction("openai", model, messages, result, elapsed_ms, llm_call=llm_call)
        return result, llm_call
    except openai.AuthenticationError as e:
        error_detail = str(e)
        # 尝试从异常对象中获取更多信息
        error_body = getattr(e, 'body', None) or getattr(e, 'response', None)
        if error_body:
            try:
                if hasattr(error_body, 'json'):
                    error_data = error_body.json()
                elif isinstance(error_body, dict):
                    error_data = error_body
                else:
                    error_data = {}
                
                error_msg_detail = error_data.get("error", {})
                if isinstance(error_msg_detail, dict):
                    error_message = error_msg_detail.get("message", error_detail)
                else:
                    error_message = str(error_msg_detail) if error_msg_detail else error_detail
            except:
                error_message = error_detail
        else:
            error_message = error_detail
            
        if "User not found" in error_message or "401" in error_message or "unauthorized" in error_message.lower():
            if "openrouter.ai" in base_url:
                error_msg = (
                    "OpenRouter API 认证失败 (401): API Key 无效、已过期或账户不存在。\n\n"
                    "请检查以下事项：\n"
                    "1. 访问 https://openrouter.ai/keys 确认 API Key 是否有效\n"
                    "2. 检查 backend/.env 中的 OPENAI_API_KEY 是否正确（应以 sk-or-v1- 开头）\n"
                    "3. 确认 OpenRouter 账户是否已激活\n"
                    "4. 检查 API Key 是否有足够的余额\n"
                    f"5. 当前使用的 API Key 前缀: {api_key[:10]}..."
                )
            else:
                error_msg = f"OpenAI API 认证失败: {error_message}。请检查 backend/.env 中的 OPENAI_API_KEY 配置"
        else:
            error_msg = f"API 认证失败: {error_message}。请检查 backend/.env 中的 OPENAI_API_KEY 配置"
        _log_interaction("openai", model, messages, "", int((time.monotonic() - t0) * 1000), error=error_msg)
        raise ValueError(error_msg) from e
    except openai.APIError as e:
        error_msg = f"OpenAI API 错误: {str(e)}"
        _log_interaction("openai", model, messages, "", int((time.monotonic() - t0) * 1000), error=error_msg)
        raise ValueError(error_msg) from e
    except Exception as e:
        error_str = str(e)
        if "User not found" in error_str or "401" in error_str or "unauthorized" in error_str.lower():
            if "openrouter.ai" in base_url:
                error_msg = (
                    "OpenRouter API 认证失败 (401): API Key 无效、已过期或账户不存在。\n\n"
                    "请检查以下事项：\n"
                    "1. 访问 https://openrouter.ai/keys 确认 API Key 是否有效\n"
                    "2. 检查 backend/.env 中的 OPENAI_API_KEY 是否正确（应以 sk-or-v1- 开头）\n"
                    "3. 确认 OpenRouter 账户是否已激活\n"
                    "4. 检查 API Key 是否有足够的余额\n"
                    f"5. 当前使用的 API Key 前缀: {api_key[:10]}..."
                )
            else:
                error_msg = "API 认证失败: API Key 无效或已过期。请检查 backend/.env 中的 OPENAI_API_KEY 配置"
        else:
            error_msg = f"调用 OpenAI API 时发生错误: {error_str}"
        _log_interaction("openai", model, messages, "", int((time.monotonic() - t0) * 1000), error=error_msg)
        raise ValueError(error_msg) from e


async def call_claude(messages: list[dict]) -> tuple[str, dict]:
    import anthropic
    import time
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
    
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY 未配置，请在 backend/.env 文件中设置")
    
    client = anthropic.AsyncAnthropic(api_key=api_key)

    system_msg = ""
    api_messages = []
    for m in messages:
        if m["role"] == "system":
            system_msg = m["content"]
        else:
            api_messages.append(m)

    t0 = time.monotonic()
    try:
        resp = await client.messages.create(
            model=model, max_tokens=8192, system=system_msg, messages=api_messages, temperature=0.3
        )
        result = resp.content[0].text
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        usage = getattr(resp, "usage", None)
        input_tokens = getattr(usage, "input_tokens", None) if usage is not None else None
        output_tokens = getattr(usage, "output_tokens", None) if usage is not None else None
        llm_call = _build_llm_call_meta(
            provider="claude",
            model=model,
            messages=messages,
            elapsed_ms=elapsed_ms,
            input_tokens=input_tokens,
            output_tokens=output_tokens if isinstance(output_tokens, int) else _estimate_tokens_from_text(result),
            token_source="provider" if isinstance(input_tokens, int) and isinstance(output_tokens, int) else "estimated",
        )
        _log_interaction("claude", model, messages, result, elapsed_ms, llm_call=llm_call)
        return result, llm_call
    except anthropic.AuthenticationError as e:
        error_msg = f"API 认证失败: API Key 无效或已过期。请检查 backend/.env 中的 ANTHROPIC_API_KEY 配置"
        _log_interaction("claude", model, messages, "", int((time.monotonic() - t0) * 1000), error=error_msg)
        raise ValueError(error_msg) from e
    except anthropic.APIError as e:
        error_msg = f"Claude API 错误: {str(e)}"
        _log_interaction("claude", model, messages, "", int((time.monotonic() - t0) * 1000), error=error_msg)
        raise ValueError(error_msg) from e
    except Exception as e:
        error_msg = f"调用 Claude API 时发生错误: {str(e)}"
        _log_interaction("claude", model, messages, "", int((time.monotonic() - t0) * 1000), error=error_msg)
        raise ValueError(error_msg) from e


async def call_custom(messages: list[dict]) -> tuple[str, dict]:
    """OpenAI-compatible custom endpoint."""
    import asyncio
    import httpx
    import time
    base_url = os.getenv("CUSTOM_BASE_URL", "").strip()
    api_key = os.getenv("CUSTOM_API_KEY", "")
    model = os.getenv("CUSTOM_MODEL", "").strip()
    if not base_url:
        raise ValueError("CUSTOM_BASE_URL 未配置，请在 backend/.env 文件中设置")
    if not model:
        raise ValueError("CUSTOM_MODEL 未配置，请在 backend/.env 文件中设置")
    base_url = base_url.rstrip("/")

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if "openrouter.ai" in base_url:
        headers["HTTP-Referer"] = "http://localhost:3000"
        headers["X-Title"] = "Nexar Code"

    def _extract_error_message(resp: httpx.Response) -> str:
        try:
            error_data = resp.json()
            error_detail = error_data.get("error", {})
            if isinstance(error_detail, dict):
                msg = error_detail.get("message", "")
                if msg:
                    return str(msg)
            if error_detail:
                return str(error_detail)
        except Exception:
            pass
        text = (resp.text or "").strip()
        return text if text else f"HTTP {resp.status_code}"

    def _extract_text_from_response(data: dict) -> str:
        choices = data.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ValueError("返回格式异常：缺少 choices 字段")
        message = choices[0].get("message", {})
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict):
                    txt = item.get("text") or item.get("content")
                    if isinstance(txt, str) and txt.strip():
                        parts.append(txt)
            if parts:
                return "\n".join(parts)
        raise ValueError("返回格式异常：message.content 为空或非文本")

    request_payloads = [
        # 标准 OpenAI 兼容参数（多数模型可用）
        {"model": model, "messages": messages, "temperature": 0.3, "max_tokens": 40000},
        # thinking/reasoning 模型常见兼容写法
        {"model": model, "messages": messages, "max_completion_tokens": 40000},
        # 最小参数兜底
        {"model": model, "messages": messages},
    ]

    endpoint_url = f"{base_url}/chat/completions"
    t0 = time.monotonic()
    try:
        data = None
        result = ""
        last_retry_error: str | None = None
        last_request_error: httpx.RequestError | None = None
        async with httpx.AsyncClient(timeout=120) as client:
            for idx, payload in enumerate(request_payloads):
                resp = None
                for retry_idx in range(3):
                    try:
                        resp = await client.post(endpoint_url, headers=headers, json=payload)
                        break
                    except httpx.RequestError as req_err:
                        last_request_error = req_err
                        if retry_idx >= 2:
                            raise
                        # 短暂网络抖动时做指数退避，避免一次失败就中断。
                        await asyncio.sleep(0.8 * (2**retry_idx))

                if resp is None:
                    if last_request_error is not None:
                        raise last_request_error
                    raise ValueError("调用自定义 API 时未收到有效响应")
                if resp.status_code >= 400:
                    err_text = _extract_error_message(resp)
                    can_retry = (
                        resp.status_code == 400
                        and idx < len(request_payloads) - 1
                        and any(
                            token in err_text.lower()
                            for token in [
                                "unsupported",
                                "not supported",
                                "invalid",
                                "max_tokens",
                                "max_completion_tokens",
                                "temperature",
                                "reasoning",
                                "thinking",
                            ]
                        )
                    )
                    if can_retry:
                        last_retry_error = err_text
                        continue
                    resp.raise_for_status()
                data = resp.json()
                result = _extract_text_from_response(data)
                break

        if data is None:
            if last_retry_error:
                raise ValueError(f"模型参数不兼容: {last_retry_error}")
            raise ValueError("调用自定义 API 时未收到有效响应")

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        usage = data.get("usage", {}) if isinstance(data, dict) else {}
        input_tokens = usage.get("prompt_tokens") if isinstance(usage, dict) else None
        output_tokens = usage.get("completion_tokens") if isinstance(usage, dict) else None
        llm_call = _build_llm_call_meta(
            provider="custom",
            model=model,
            messages=messages,
            elapsed_ms=elapsed_ms,
            input_tokens=input_tokens if isinstance(input_tokens, int) else None,
            output_tokens=output_tokens if isinstance(output_tokens, int) else _estimate_tokens_from_text(result),
            token_source="provider" if isinstance(input_tokens, int) and isinstance(output_tokens, int) else "estimated",
        )
        _log_interaction("custom", model, messages, result, elapsed_ms, llm_call=llm_call)
        return result, llm_call
    except httpx.HTTPStatusError as e:
        status_code = e.response.status_code
        error_message = _extract_error_message(e.response)
        
        if status_code == 401:
            if "openrouter.ai" in base_url:
                if "User not found" in error_message:
                    error_msg = "OpenRouter API 认证失败: API Key 无效、已过期或账户不存在。请检查：\n1. backend/.env 中的 CUSTOM_API_KEY 是否正确\n2. OpenRouter 账户是否有效\n3. API Key 是否有足够的余额\n4. 访问 https://openrouter.ai/keys 查看 API Key 状态"
                else:
                    error_msg = f"OpenRouter API 认证失败 (401): {error_message}。请检查 backend/.env 中的 CUSTOM_API_KEY 配置"
            else:
                error_msg = f"API 认证失败 (401): {error_message}。请检查 backend/.env 中的 CUSTOM_API_KEY 配置"
        elif status_code == 404:
            error_msg = f"API 端点不存在 (404): 请检查 backend/.env 中的 CUSTOM_BASE_URL 配置"
        elif status_code == 400:
            error_msg = (
                f"API 参数不兼容 (400): {error_message}。"
                "这通常是模型参数与接口不匹配（常见于 thinking/reasoning 模型）。"
            )
        else:
            error_msg = f"API 请求失败 ({status_code}): {error_message}"
        _log_interaction("custom", model, messages, "", int((time.monotonic() - t0) * 1000), error=error_msg)
        raise ValueError(error_msg) from e
    except httpx.RequestError as e:
        detail = str(e).strip()
        if not detail:
            root_cause = getattr(e, "__cause__", None)
            detail = str(root_cause).strip() if root_cause else ""
        if not detail:
            detail = repr(e)

        request_url = ""
        try:
            request_url = str(e.request.url) if e.request else endpoint_url
        except Exception:
            request_url = endpoint_url

        openrouter_hint = ""
        if "openrouter.ai" in base_url:
            openrouter_hint = "；若你在中国大陆网络环境，通常还需要可用代理/VPN 才能访问 openrouter.ai"

        error_msg = (
            f"无法连接到 API 服务器: {detail}（URL: {request_url}）。"
            "请检查 backend/.env 中的 CUSTOM_BASE_URL 配置与网络连通性"
            f"{openrouter_hint}"
        )
        _log_interaction("custom", model, messages, "", int((time.monotonic() - t0) * 1000), error=error_msg)
        raise ValueError(error_msg) from e
    except Exception as e:
        error_msg = f"调用自定义 API 时发生错误: {str(e)}"
        _log_interaction("custom", model, messages, "", int((time.monotonic() - t0) * 1000), error=error_msg)
        raise ValueError(error_msg) from e


async def plan_actions(
    provider: AIProvider,
    request: AIRequestSnapshot,
    iteration: int,
    original_user_query: str,
    action_history: list[ActionExecutionRecord],
    context_snapshot: dict,
    available_actions: list[str],
) -> ActionBatch:
    cfg = request.history_config
    turns = cfg.turns if cfg else 40
    max_chars_per_message = cfg.max_chars_per_message if cfg else 4000
    summary_enabled = cfg.summary_enabled if cfg else True
    summary_max_chars = cfg.summary_max_chars if cfg else 1200

    # Include recent chat turns so first planning step of each run keeps dialog continuity.
    planner_turns = min(turns, 12)
    planner_msg_chars = min(max_chars_per_message, 600)
    recent_messages = request.messages[-planner_turns:]
    omitted_messages = request.messages[:-planner_turns] if len(request.messages) > planner_turns else []
    conversation_history = []
    for msg in recent_messages:
        text = msg.content or ""
        if len(text) > planner_msg_chars:
            text = text[:planner_msg_chars]
        conversation_history.append(
            {
                "role": msg.role,
                "content": text,
            }
        )
    conversation_summary = _build_history_summary(omitted_messages, max_chars=summary_max_chars) if summary_enabled else ""

    history_payload = []
    for rec in action_history[-24:]:
        compact_output = _compact_history_output_for_planner(rec.action_type, rec.output)
        payload_item = {
            "iteration": rec.iteration,
            "action_id": rec.action_id,
            "action_type": rec.action_type.value,
            "status": rec.status,
            "title": rec.title,
            "error": rec.error,
            "key_result": _extract_key_result_for_planner(rec.action_type, compact_output),
        }
        if rec.action_type in {ActionType.READ_FILES, ActionType.READ_FILE_RANGES, ActionType.EXTRACT_SYMBOLS}:
            payload_item["output"] = compact_output
        history_payload.append(payload_item)

    runtime_constraints = {
        "chat_only": request.chat_only,
        "force_code_edit": request.force_code_edit,
        "range_start": request.range_start,
        "range_end": request.range_end,
    }
    compact_context = _compact_context_snapshot_for_planner(context_snapshot)
    planner_input = {
        "original_user_query": original_user_query,
        "iteration": iteration,
        "runtime_constraints": runtime_constraints,
        "current_file": request.current_file,
        "snippets": [
            {
                "file_path": s.file_path,
                "start_line": s.start_line,
                "end_line": s.end_line,
            }
            for s in (request.snippets or [])[:20]
        ],
        "context_snapshot": compact_context,
        "conversation_omitted_count": max(0, len(request.messages) - len(recent_messages)),
        "history_config": {
            "turns": turns,
            "max_chars_per_message": max_chars_per_message,
            "summary_enabled": summary_enabled,
            "summary_max_chars": summary_max_chars,
        },
        "prior_actions": history_payload,
        "available_actions": available_actions,
    }
    planner_brief = _build_planner_brief(
        original_user_query=original_user_query,
        iteration=iteration,
        conversation_summary=conversation_summary,
        conversation_history=conversation_history,
        history_payload=history_payload,
        runtime_constraints=runtime_constraints,
        context_snapshot_compact=compact_context,
    )
    messages = [
        {"role": "system", "content": PLANNER_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                "以下是本轮规划简报（优先阅读）：\n"
                f"{planner_brief}\n\n"
                "以下是机器状态（JSON，按需引用）：\n"
                f"{json.dumps(planner_input, ensure_ascii=False)}"
            ),
        },
    ]
    callers = {
        AIProvider.OPENAI: call_openai,
        AIProvider.CLAUDE: call_claude,
        AIProvider.CUSTOM: call_custom,
    }
    caller = callers.get(provider, call_openai)
    raw, llm_call = await caller(messages)
    try:
        batch = _parse_action_batch_response(raw, iteration=iteration)
        batch.llm_call = llm_call
        return batch
    except Exception as e:
        preview = (raw or "").strip().replace("\n", "\\n")
        if len(preview) > 800:
            preview = preview[:800] + "...(truncated)"
        logger.warning("[planner_parse_failed] provider=%s iteration=%s error=%s raw=%s", provider.value, iteration, str(e), preview)
        # Safe fallback so orchestrator can continue with user-visible guidance.
        return ActionBatch(
            version="1.0",
            iteration=iteration,
            summary="Planner 输出不可解析，等待用户确认下一步。",
            decision=ActionBatchDecision(mode="ask_user", reason="planner_parse_failed", needs_user_trigger=False),
            actions=[
                ActionSpec(
                    id="a1",
                    type=ActionType.ASK_USER,
                    title="请求用户确认",
                    reason="planner_parse_failed",
                    input={"question": "本轮规划解析失败。是否继续尝试重新规划？"},
                    success_criteria=["用户给出下一步偏好"],
                )
            ],
            acceptance=[],
            risks=["planner_parse_failed"],
            next_questions=["是否继续重试规划？"],
            llm_call=llm_call,
        )


async def chat(
    provider: AIProvider,
    messages: list[ChatMessage],
    current_file: str | None = None,
    current_code: str | None = None,
    file_path: str | None = None,
    snippets: list[CodeSnippet] | None = None,
    chat_only: bool = False,
    planning_mode: bool = False,
    range_start: int | None = None,
    range_end: int | None = None,
) -> AIResponse:
    action = _infer_action(messages, current_file, file_path, snippets, chat_only, planning_mode, range_start, range_end)
    built = _build_messages(
        messages, current_file, current_code, action, file_path,
        snippets, chat_only, planning_mode, range_start, range_end
    )

    callers = {
        AIProvider.OPENAI: call_openai,
        AIProvider.CLAUDE: call_claude,
        AIProvider.CUSTOM: call_custom,
    }
    caller = callers.get(provider, call_openai)
    raw, llm_call = await caller(built)
    parsed = _parse_ai_response(raw, action)
    parsed.llm_call = llm_call
    return parsed
