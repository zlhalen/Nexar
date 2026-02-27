import os
import shutil
from pathlib import Path
from backend.models.schemas import FileItem, FileContent

WORKSPACE_ROOT = os.getenv("WORKSPACE_ROOT", os.path.join(os.path.dirname(__file__), "..", "..", "workspace"))


def get_workspace_root() -> str:
    root = os.path.abspath(WORKSPACE_ROOT)
    os.makedirs(root, exist_ok=True)
    return root


def _safe_path(relative_path: str) -> str:
    """Ensure path is within workspace to prevent directory traversal attacks."""
    root = get_workspace_root()
    full = os.path.normpath(os.path.join(root, relative_path))
    if not full.startswith(root):
        raise ValueError("Path traversal detected")
    return full


def _get_language(filename: str) -> str:
    ext_map = {
        ".py": "python", ".js": "javascript", ".ts": "typescript",
        ".tsx": "typescriptreact", ".jsx": "javascriptreact",
        ".html": "html", ".css": "css", ".scss": "scss",
        ".json": "json", ".md": "markdown", ".yaml": "yaml",
        ".yml": "yaml", ".xml": "xml", ".sql": "sql",
        ".sh": "shell", ".bash": "shell", ".go": "go",
        ".rs": "rust", ".java": "java", ".c": "c",
        ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
        ".rb": "ruby", ".php": "php", ".swift": "swift",
        ".kt": "kotlin", ".dart": "dart", ".vue": "vue",
        ".svelte": "svelte", ".toml": "toml", ".ini": "ini",
        ".env": "dotenv", ".txt": "plaintext",
    }
    _, ext = os.path.splitext(filename)
    return ext_map.get(ext.lower(), "plaintext")


def list_directory(relative_path: str = "") -> list[FileItem]:
    full_path = _safe_path(relative_path)
    if not os.path.isdir(full_path):
        raise FileNotFoundError(f"Directory not found: {relative_path}")

    items = []
    try:
        entries = sorted(os.listdir(full_path), key=lambda x: (not os.path.isdir(os.path.join(full_path, x)), x.lower()))
    except PermissionError:
        return items

    for entry in entries:
        if entry.startswith("."):
            continue
        entry_full = os.path.join(full_path, entry)
        entry_rel = os.path.join(relative_path, entry) if relative_path else entry
        is_dir = os.path.isdir(entry_full)
        item = FileItem(name=entry, path=entry_rel, is_dir=is_dir)
        if is_dir:
            item.children = list_directory(entry_rel)
        items.append(item)
    return items


def read_file(relative_path: str) -> FileContent:
    full_path = _safe_path(relative_path)
    if not os.path.isfile(full_path):
        raise FileNotFoundError(f"File not found: {relative_path}")
    with open(full_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    return FileContent(path=relative_path, content=content, language=_get_language(relative_path))


def write_file(relative_path: str, content: str) -> FileContent:
    full_path = _safe_path(relative_path)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, "w", encoding="utf-8") as f:
        f.write(content)
    return FileContent(path=relative_path, content=content, language=_get_language(relative_path))


def write_file_range(relative_path: str, replacement: str, start_line: int, end_line: int) -> FileContent:
    if start_line < 1 or end_line < start_line:
        raise ValueError("Invalid range: range_start/range_end must satisfy 1 <= range_start <= range_end")

    current = read_file(relative_path)
    lines = current.content.splitlines(keepends=True)

    if not lines:
        if start_line != 1 or end_line != 1:
            raise ValueError("Invalid range for empty file: only 1-1 is allowed")
        return write_file(relative_path, replacement)

    total = len(lines)
    if end_line > total:
        raise ValueError(f"Invalid range: file has {total} lines, but range_end={end_line}")

    new_content = "".join(lines[: start_line - 1]) + replacement + "".join(lines[end_line:])
    return write_file(relative_path, new_content)


def create_item(relative_path: str, is_dir: bool = False, content: str = "") -> bool:
    full_path = _safe_path(relative_path)
    if is_dir:
        os.makedirs(full_path, exist_ok=True)
    else:
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "w", encoding="utf-8") as f:
            f.write(content)
    return True


def delete_item(relative_path: str) -> bool:
    full_path = _safe_path(relative_path)
    if os.path.isdir(full_path):
        shutil.rmtree(full_path)
    elif os.path.isfile(full_path):
        os.remove(full_path)
    else:
        raise FileNotFoundError(f"Not found: {relative_path}")
    return True


def rename_item(old_path: str, new_path: str) -> bool:
    old_full = _safe_path(old_path)
    new_full = _safe_path(new_path)
    if not os.path.exists(old_full):
        raise FileNotFoundError(f"Not found: {old_path}")
    os.makedirs(os.path.dirname(new_full), exist_ok=True)
    shutil.move(old_full, new_full)
    return True
