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
            action=req.action,
            file_path=req.file_path,
        )

        if result.file_path and result.file_content and result.action in ("generate", "modify"):
            file_service.write_file(result.file_path, result.file_content)

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
