import os
import pty
import select
import signal
import subprocess
import uuid
from dataclasses import dataclass
from threading import Lock
from typing import Optional


@dataclass
class TerminalSession:
    session_id: str
    process: subprocess.Popen
    master_fd: int
    cwd: str
    shell: str


class TerminalSessionManager:
    def __init__(self):
        self._sessions: dict[str, TerminalSession] = {}
        self._lock = Lock()

    def create_session(self, cwd: str, shell: str) -> TerminalSession:
        master_fd, slave_fd = pty.openpty()
        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        env.setdefault("COLORTERM", "truecolor")
        env["HOME"] = cwd
        env["PS1"] = r"\W $ "
        env["PROMPT_COMMAND"] = ""
        env["CLICOLOR"] = "0"
        env["LSCOLORS"] = ""

        shell_args = [shell, "-i"]
        if shell.endswith("bash"):
            shell_args = [shell, "--noprofile", "--norc", "-i"]

        process = subprocess.Popen(
            shell_args,
            cwd=cwd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            preexec_fn=os.setsid,
            env=env,
            close_fds=True,
            text=False,
        )
        os.close(slave_fd)
        os.set_blocking(master_fd, False)

        session = TerminalSession(
            session_id=str(uuid.uuid4()),
            process=process,
            master_fd=master_fd,
            cwd=cwd,
            shell=shell,
        )
        with self._lock:
            self._sessions[session.session_id] = session
        return session

    def get_session(self, session_id: str) -> TerminalSession:
        with self._lock:
            session = self._sessions.get(session_id)
        if not session:
            raise KeyError(f"Terminal session not found: {session_id}")
        return session

    def write_input(self, session_id: str, data: str) -> None:
        session = self.get_session(session_id)
        if session.process.poll() is not None:
            return
        os.write(session.master_fd, data.encode("utf-8", errors="replace"))

    def read_output(self, session_id: str) -> tuple[str, bool, Optional[int]]:
        session = self.get_session(session_id)
        chunks: list[bytes] = []
        while True:
            readable, _, _ = select.select([session.master_fd], [], [], 0)
            if not readable:
                break
            try:
                part = os.read(session.master_fd, 4096)
            except BlockingIOError:
                break
            except OSError:
                break
            if not part:
                break
            chunks.append(part)
        output = b"".join(chunks).decode("utf-8", errors="replace")
        exit_code = session.process.poll()
        alive = exit_code is None
        return output, alive, exit_code

    def close_session(self, session_id: str) -> None:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if not session:
            return
        try:
            if session.process.poll() is None:
                os.killpg(os.getpgid(session.process.pid), signal.SIGTERM)
                session.process.wait(timeout=1.5)
        except Exception:
            try:
                if session.process.poll() is None:
                    os.killpg(os.getpgid(session.process.pid), signal.SIGKILL)
            except Exception:
                pass
        finally:
            try:
                os.close(session.master_fd)
            except OSError:
                pass
