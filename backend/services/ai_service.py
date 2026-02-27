import os
import json
import re
import logging
from datetime import datetime
from typing import AsyncGenerator
from backend.models.schemas import AIProvider, ChatMessage, AIResponse

logger = logging.getLogger("ai_service")

LOG_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "logs")
os.makedirs(LOG_DIR, exist_ok=True)


def _log_interaction(provider: str, model: str, messages: list[dict], response: str, elapsed_ms: int, error: str | None = None):
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

当用户只是提问或聊天时，直接用普通文字回复即可。

注意事项：
- 生成的代码要完整、可运行
- 修改文件时返回修改后的完整文件内容
- file_path使用相对路径
- 代码要符合最佳实践，有适当注释"""


def _build_messages(messages: list[ChatMessage], current_file: str | None, current_code: str | None, action: str, file_path: str | None) -> list[dict]:
    built = [{"role": "system", "content": SYSTEM_PROMPT}]

    if current_file and current_code:
        context = f"\n\n[当前打开的文件: {current_file}]\n```\n{current_code}\n```"
    else:
        context = ""

    if action == "generate" and file_path:
        context += f"\n\n[用户要求生成文件: {file_path}，请以JSON格式返回结果]"
    elif action == "modify" and current_file:
        context += f"\n\n[用户要求修改文件: {current_file}，请以JSON格式返回修改后的完整文件]"

    for msg in messages:
        content = msg.content
        if msg.role == "user" and msg == messages[-1]:
            content += context
        built.append({"role": msg.role, "content": content})

    return built


def _parse_ai_response(raw: str, action: str) -> AIResponse:
    json_match = re.search(r'```json\s*\n?(.*?)\n?\s*```', raw, re.DOTALL)
    if not json_match:
        json_match = re.search(r'\{[^{}]*"action"[^{}]*"file_path"[^{}]*\}', raw, re.DOTALL)

    if json_match:
        try:
            text = json_match.group(1) if '```' in json_match.group(0) else json_match.group(0)
            data = json.loads(text)
            return AIResponse(
                content=data.get("explanation", raw),
                file_path=data.get("file_path"),
                file_content=data.get("file_content"),
                action=data.get("action", action),
            )
        except (json.JSONDecodeError, AttributeError):
            pass

    return AIResponse(content=raw, action="chat")


async def call_openai(messages: list[dict]) -> str:
    import openai
    import time
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    model = os.getenv("OPENAI_MODEL", "gpt-4o")
    extra_headers = {}
    if "openrouter.ai" in base_url:
        extra_headers = {
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "AI CodeGen",
        }
    client = openai.AsyncOpenAI(
        api_key=os.getenv("OPENAI_API_KEY", ""),
        base_url=base_url,
        default_headers=extra_headers,
    )
    t0 = time.monotonic()
    try:
        resp = await client.chat.completions.create(model=model, messages=messages, temperature=0.3, max_tokens=8192)
        result = resp.choices[0].message.content or ""
        _log_interaction("openai", model, messages, result, int((time.monotonic() - t0) * 1000))
        return result
    except Exception as e:
        _log_interaction("openai", model, messages, "", int((time.monotonic() - t0) * 1000), error=str(e))
        raise


async def call_claude(messages: list[dict]) -> str:
    import anthropic
    import time
    client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")

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
        _log_interaction("claude", model, messages, result, int((time.monotonic() - t0) * 1000))
        return result
    except Exception as e:
        _log_interaction("claude", model, messages, "", int((time.monotonic() - t0) * 1000), error=str(e))
        raise


async def call_custom(messages: list[dict]) -> str:
    """OpenAI-compatible custom endpoint."""
    import httpx
    import time
    base_url = os.getenv("CUSTOM_BASE_URL", "")
    api_key = os.getenv("CUSTOM_API_KEY", "")
    model = os.getenv("CUSTOM_MODEL", "")
    if not base_url:
        raise ValueError("CUSTOM_BASE_URL not configured")

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if "openrouter.ai" in base_url:
        headers["HTTP-Referer"] = "http://localhost:3000"
        headers["X-Title"] = "AI CodeGen"

    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{base_url}/chat/completions",
                headers=headers,
                json={"model": model, "messages": messages, "temperature": 0.3, "max_tokens": 8192},
            )
            resp.raise_for_status()
            data = resp.json()
            result = data["choices"][0]["message"]["content"]
        _log_interaction("custom", model, messages, result, int((time.monotonic() - t0) * 1000))
        return result
    except Exception as e:
        _log_interaction("custom", model, messages, "", int((time.monotonic() - t0) * 1000), error=str(e))
        raise


async def chat(
    provider: AIProvider,
    messages: list[ChatMessage],
    current_file: str | None = None,
    current_code: str | None = None,
    action: str = "chat",
    file_path: str | None = None,
) -> AIResponse:
    built = _build_messages(messages, current_file, current_code, action, file_path)

    callers = {
        AIProvider.OPENAI: call_openai,
        AIProvider.CLAUDE: call_claude,
        AIProvider.CUSTOM: call_custom,
    }
    caller = callers.get(provider, call_openai)
    raw = await caller(built)
    return _parse_ai_response(raw, action)
