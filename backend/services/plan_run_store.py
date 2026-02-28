from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime
import logging

from backend.models.schemas import AIResponse, PlanRunInfo, StepRunInfo

LOG_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "logs")
PLAN_RUN_DIR = os.path.join(LOG_DIR, "plan_runs")
os.makedirs(PLAN_RUN_DIR, exist_ok=True)
logger = logging.getLogger("plan_run_store")


class PlanRunStore:
    """Persistent step-run state store backed by JSON files."""

    def __init__(self):
        self._lock = threading.Lock()

    def create_run(self, intent: str, steps: list[StepRunInfo], max_retries: int) -> PlanRunInfo:
        run = PlanRunInfo(
            run_id=str(uuid.uuid4()),
            intent=intent,
            status="running",
            max_retries=max_retries,
            current_step_index=-1,
            steps=steps,
            started_at=datetime.utcnow().isoformat(),
            finished_at=None,
        )
        self.save(run)
        logger.info("[PlanRunStore] create_run run_id=%s intent=%s steps=%d", run.run_id, intent, len(steps))
        return run

    def save(self, run: PlanRunInfo) -> PlanRunInfo:
        path = self._path(run.run_id)
        with self._lock:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(run.model_dump(), f, ensure_ascii=False, indent=2)
        logger.info(
            "[PlanRunStore] save run_id=%s status=%s current_step=%d path=%s",
            run.run_id,
            run.status,
            run.current_step_index,
            path,
        )
        return run

    def get(self, run_id: str) -> PlanRunInfo:
        path = self._path(run_id)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Plan run not found: {run_id}")
        with self._lock:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        logger.info("[PlanRunStore] get run_id=%s status=%s", run_id, data.get("status"))
        return PlanRunInfo(**data)

    def mark_step_running(self, run: PlanRunInfo, step_index: int) -> PlanRunInfo:
        run.current_step_index = step_index
        run.steps[step_index].status = "in_progress"
        logger.info("[PlanRunStore] step_running run_id=%s step_index=%d", run.run_id, step_index)
        self.save(run)
        return run

    def mark_step_retry(self, run: PlanRunInfo, step_index: int, attempt: int, error: str) -> PlanRunInfo:
        step = run.steps[step_index]
        step.attempts = attempt
        step.error = error
        step.status = "in_progress"
        logger.warning(
            "[PlanRunStore] step_retry run_id=%s step_index=%d attempt=%d error=%s",
            run.run_id,
            step_index,
            attempt,
            error,
        )
        self.save(run)
        return run

    def mark_step_completed(self, run: PlanRunInfo, step_index: int, attempt: int) -> PlanRunInfo:
        step = run.steps[step_index]
        step.attempts = attempt
        step.error = None
        step.status = "completed"
        logger.info(
            "[PlanRunStore] step_completed run_id=%s step_index=%d attempt=%d",
            run.run_id,
            step_index,
            attempt,
        )
        self.save(run)
        return run

    def mark_step_failed(self, run: PlanRunInfo, step_index: int, attempt: int, error: str) -> PlanRunInfo:
        step = run.steps[step_index]
        step.attempts = attempt
        step.error = error
        step.status = "failed"
        logger.error(
            "[PlanRunStore] step_failed run_id=%s step_index=%d attempt=%d error=%s",
            run.run_id,
            step_index,
            attempt,
            error,
        )
        self.save(run)
        return run

    def mark_run_finished(self, run: PlanRunInfo, status: str) -> PlanRunInfo:
        run.status = status
        run.finished_at = datetime.utcnow().isoformat()
        logger.info("[PlanRunStore] run_finished run_id=%s status=%s", run.run_id, status)
        self.save(run)
        return run

    def mark_run_result(self, run: PlanRunInfo, result: AIResponse | None) -> PlanRunInfo:
        if result is None:
            logger.info("[PlanRunStore] run_result_skipped run_id=%s reason=no_result", run.run_id)
            return run
        run.result_action = result.action
        run.result_content = result.content
        run.result_file_path = result.file_path
        run.result_file_content = result.file_content
        run.result_changes = result.changes or []
        logger.info(
            "[PlanRunStore] run_result run_id=%s action=%s file_path=%s changes=%d",
            run.run_id,
            run.result_action,
            run.result_file_path,
            len(run.result_changes),
        )
        self.save(run)
        return run

    def _path(self, run_id: str) -> str:
        safe_id = run_id.replace("/", "_")
        return os.path.join(PLAN_RUN_DIR, f"{safe_id}.json")
