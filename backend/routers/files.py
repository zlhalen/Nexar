from fastapi import APIRouter, HTTPException
from backend.models.schemas import FileItem, FileContent, CreateFileRequest, RenameRequest, DeleteRequest
from backend.services import file_service

router = APIRouter(prefix="/api/files", tags=["files"])


@router.get("/tree", response_model=list[FileItem])
async def get_file_tree(path: str = ""):
    try:
        return file_service.list_directory(path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/read", response_model=FileContent)
async def read_file(path: str):
    try:
        return file_service.read_file(path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/write", response_model=FileContent)
async def write_file(req: FileContent):
    try:
        return file_service.write_file(req.path, req.content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/create")
async def create_item(req: CreateFileRequest):
    try:
        file_service.create_item(req.path, req.is_dir, req.content)
        return {"success": True, "path": req.path}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/delete")
async def delete_item(req: DeleteRequest):
    try:
        file_service.delete_item(req.path)
        return {"success": True}
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/rename")
async def rename_item(req: RenameRequest):
    try:
        file_service.rename_item(req.old_path, req.new_path)
        return {"success": True}
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
