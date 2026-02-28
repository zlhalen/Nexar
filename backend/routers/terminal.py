from fastapi import APIRouter, HTTPException

from backend.models.schemas import (
    TerminalSessionCreateRequest,
    TerminalSessionInfo,
    TerminalSessionInputRequest,
    TerminalSessionOutputResponse,
)
from backend.services.file_service import get_workspace_root, _safe_path
from backend.services.terminal_service import TerminalSessionManager

router = APIRouter(prefix="/api/terminal", tags=["terminal"])
terminal_manager = TerminalSessionManager()


@router.post("/sessions", response_model=TerminalSessionInfo)
async def create_terminal_session(req: TerminalSessionCreateRequest):
    shell = (req.shell or "").strip() or "/bin/bash"
    if not shell.startswith("/"):
        raise HTTPException(status_code=400, detail="shell must be an absolute path")

    try:
        target_cwd = _safe_path(req.cwd.strip()) if req.cwd.strip() else get_workspace_root()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        session = terminal_manager.create_session(cwd=target_cwd, shell=shell)
        output, alive, exit_code = terminal_manager.read_output(session.session_id)
        return TerminalSessionInfo(
            session_id=session.session_id,
            cwd=session.cwd,
            shell=session.shell,
            output=output,
            alive=alive,
            exit_code=exit_code,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=400, detail=f"Shell not found: {shell}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create terminal session: {str(e)}")


@router.post("/sessions/{session_id}/input")
async def write_terminal_input(session_id: str, req: TerminalSessionInputRequest):
    if not req.data:
        raise HTTPException(status_code=400, detail="input data cannot be empty")
    try:
        terminal_manager.write_input(session_id, req.data)
        return {"success": True}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write input: {str(e)}")


@router.get("/sessions/{session_id}/output", response_model=TerminalSessionOutputResponse)
async def read_terminal_output(session_id: str):
    try:
        output, alive, exit_code = terminal_manager.read_output(session_id)
        return TerminalSessionOutputResponse(
            session_id=session_id,
            output=output,
            alive=alive,
            exit_code=exit_code,
        )
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read output: {str(e)}")


@router.delete("/sessions/{session_id}")
async def close_terminal_session(session_id: str):
    try:
        terminal_manager.close_session(session_id)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to close session: {str(e)}")
