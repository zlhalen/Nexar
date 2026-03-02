import os
import logging
from fastapi import APIRouter, BackgroundTasks, HTTPException

from backend.models.schemas import AIRequest, AIResponse, PlanRunInfo, StartRunResponse
from backend.services.agent_system import ClosedLoopAgent
from backend.services.plan_run_store import PlanRunStore

router = APIRouter(prefix="/api/ai", tags=["ai"])
agent = ClosedLoopAgent()
run_store = PlanRunStore()
logger = logging.getLogger("ai_router")


@router.post("/chat", response_model=AIResponse)
async def chat(req: AIRequest):
    try:
        logger.info(
            "[/api/ai/chat] provider=%s messages=%d planning_mode=%s chat_only=%s force_code_edit=%s current_file=%s",
            req.provider,
            len(req.messages),
            req.planning_mode,
            req.chat_only,
            req.force_code_edit,
            req.current_file,
        )
        return await agent.execute(req)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI service error: {str(e)}")


@router.get("/providers")
async def list_providers():
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


@router.get("/runs/{run_id}", response_model=PlanRunInfo)
async def get_plan_run(run_id: str):
    try:
        logger.info("[/api/ai/runs/{id}] run_id=%s", run_id)
        return run_store.get(run_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Plan run load error: {str(e)}")


@router.post("/runs/start", response_model=StartRunResponse)
async def start_plan_run(req: AIRequest, background_tasks: BackgroundTasks):
    try:
        logger.info(
            "[/api/ai/runs/start] provider=%s messages=%d planning_mode=%s chat_only=%s force_code_edit=%s current_file=%s",
            req.provider,
            len(req.messages),
            req.planning_mode,
            req.chat_only,
            req.force_code_edit,
            req.current_file,
        )
        run_id = agent.create_run(req)
        background_tasks.add_task(agent.execute_by_run_id, req, run_id)
        logger.info("[/api/ai/runs/start] started run_id=%s", run_id)
        return StartRunResponse(run_id=run_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Plan run start error: {str(e)}")


@router.post("/runs/{run_id}/continue", response_model=AIResponse)
async def continue_plan_run(run_id: str):
    try:
        logger.info("[/api/ai/runs/{id}/continue] run_id=%s", run_id)
        return await agent.continue_run(run_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Plan run continue error: {str(e)}")


@router.post("/runs/{run_id}/pause", response_model=PlanRunInfo)
async def pause_plan_run(run_id: str):
    try:
        logger.info("[/api/ai/runs/{id}/pause] run_id=%s", run_id)
        return agent.pause_run(run_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Plan run pause error: {str(e)}")


@router.post("/runs/{run_id}/resume", response_model=PlanRunInfo)
async def resume_plan_run(run_id: str):
    try:
        logger.info("[/api/ai/runs/{id}/resume] run_id=%s", run_id)
        return agent.resume_run(run_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Plan run resume error: {str(e)}")


@router.post("/runs/{run_id}/cancel", response_model=PlanRunInfo)
async def cancel_plan_run(run_id: str):
    try:
        logger.info("[/api/ai/runs/{id}/cancel] run_id=%s", run_id)
        return agent.cancel_run(run_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Plan run cancel error: {str(e)}")
