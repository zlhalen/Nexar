from fastapi import APIRouter, HTTPException
from backend.models.schemas import AIRequest, AIResponse
from backend.services import ai_service, file_service

router = APIRouter(prefix="/api/ai", tags=["ai"])


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
            range_start=req.range_start,
            range_end=req.range_end,
        )

        if req.chat_only:
            result.action = "chat"
            result.file_path = None
            result.file_content = None
            return result

        if result.file_content and result.action in ("generate", "modify"):
            target_path = result.file_path or req.file_path or req.current_file
            if not target_path:
                raise ValueError("Missing file path for write operation")

            if result.action == "modify" and req.range_start is not None and req.range_end is not None:
                updated = file_service.write_file_range(
                    target_path,
                    result.file_content,
                    req.range_start,
                    req.range_end,
                )
            else:
                updated = file_service.write_file(target_path, result.file_content)

            result.file_path = target_path
            result.file_content = updated.content

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
