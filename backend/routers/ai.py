from fastapi import APIRouter, HTTPException
import difflib
import hashlib
from backend.models.schemas import AIRequest, AIResponse, FileChange
from backend.services import ai_service, file_service

router = APIRouter(prefix="/api/ai", tags=["ai"])


def _text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _build_unified_diff(path: str, before: str, after: str) -> str:
    before_lines = before.splitlines()
    after_lines = after.splitlines()
    diff = difflib.unified_diff(
        before_lines,
        after_lines,
        fromfile=f"a/{path}",
        tofile=f"b/{path}",
        lineterm="",
    )
    return "\n".join(diff)


@router.post("/chat", response_model=AIResponse)
async def chat(req: AIRequest):
    try:
        result = await ai_service.chat(
            provider=req.provider,
            messages=req.messages,
            current_file=req.current_file,
            current_code=req.current_code,
            file_path=req.file_path,
            snippets=req.snippets,
            chat_only=req.chat_only,
            planning_mode=req.planning_mode,
            range_start=req.range_start,
            range_end=req.range_end,
        )

        if req.planning_mode:
            result.action = "plan"
            result.file_path = None
            result.file_content = None
            return result
        if req.chat_only:
            result.action = "chat"
            result.file_path = None
            result.file_content = None
            return result

        if result.action in ("generate", "modify"):
            requested_changes: list[FileChange] = []

            if result.changes:
                requested_changes = result.changes
            elif result.file_content:
                target_path = result.file_path or req.file_path or req.current_file
                if not target_path:
                    raise ValueError("Missing file path for write operation")
                requested_changes = [FileChange(file_path=target_path, file_content=result.file_content)]

            if requested_changes:
                written_changes: list[FileChange] = []
                failed_changes: list[FileChange] = []

                for idx, change in enumerate(requested_changes):
                    path = change.file_path
                    before_content = ""
                    try:
                        before_content = file_service.read_file(path).content
                    except FileNotFoundError:
                        before_content = ""

                    try:
                        if (
                            result.action == "modify"
                            and req.range_start is not None
                            and req.range_end is not None
                            and len(requested_changes) == 1
                        ):
                            updated = file_service.write_file_range(
                                path,
                                change.file_content,
                                req.range_start,
                                req.range_end,
                            )
                        else:
                            if req.range_start is not None and req.range_end is not None and len(requested_changes) > 1:
                                raise ValueError("Range modify does not support multi-file changes")
                            updated = file_service.write_file(path, change.file_content)

                        after_content = updated.content
                        written_changes.append(
                            FileChange(
                                file_path=path,
                                file_content=after_content,
                                before_content=before_content,
                                after_content=after_content,
                                diff_unified=_build_unified_diff(path, before_content, after_content),
                                before_hash=_text_hash(before_content),
                                after_hash=_text_hash(after_content),
                                write_result="written",
                            )
                        )
                    except Exception as write_err:
                        failed_changes.append(
                            FileChange(
                                file_path=path,
                                file_content=change.file_content,
                                before_content=before_content,
                                after_content=before_content,
                                diff_unified="",
                                before_hash=_text_hash(before_content),
                                after_hash=_text_hash(before_content),
                                write_result="failed",
                                error=str(write_err),
                            )
                        )

                all_changes = written_changes + failed_changes
                result.changes = all_changes

                if written_changes:
                    # Keep backward compatibility for single-file UI paths.
                    latest = written_changes[-1]
                    result.file_path = latest.file_path
                    result.file_content = latest.after_content

                if failed_changes:
                    failed_paths = ", ".join(c.file_path for c in failed_changes[:3])
                    result.content = f"{result.content}\n\n部分文件写入失败: {failed_paths}".strip()

        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI service error: {str(e)}")


@router.get("/providers")
async def list_providers():
    import os
    providers = []
    if os.getenv("OPENAI_API_KEY"):
        providers.append({"id": "openai", "name": "OpenAI", "model": os.getenv("OPENAI_MODEL", "gpt-4o")})
    if os.getenv("ANTHROPIC_API_KEY"):
        providers.append({"id": "claude", "name": "Claude", "model": os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")})
    if os.getenv("CUSTOM_BASE_URL"):
        providers.append({"id": "custom", "name": "Custom", "model": os.getenv("CUSTOM_MODEL", "custom")})
    if not providers:
        providers.append({"id": "openai", "name": "OpenAI (未配置)", "model": "gpt-4o"})
    return providers
