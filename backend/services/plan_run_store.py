from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from datetime import datetime
from typing import Any

from backend.models.schemas import (
    AIRequest,
    AIRequestSnapshot,
    AIResponse,
    ActionBatch,
    ActionExecutionRecord,
    ExecutionEvent,
    PlanRunInfo,
)

LOG_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "logs")
PLAN_RUN_DIR = os.path.join(LOG_DIR, "plan_runs")
os.makedirs(PLAN_RUN_DIR, exist_ok=True)
logger = logging.getLogger("plan_run_store")


class PlanRunStore:
    """Persistent run store backed by JSON files."""

    def __init__(self):
        self._lock = threading.Lock()

    def create_run(self, intent: str, max_retries: int, request: AIRequest | AIRequestSnapshot) -> PlanRunInfo:
        snapshot = request if isinstance(request, AIRequestSnapshot) else AIRequestSnapshot(**request.model_dump())
        run = PlanRunInfo(
            run_id=str(uuid.uuid4()),
            intent=intent,
            status="running",
            max_retries=max_retries,
            started_at=datetime.utcnow().isoformat(),
            request_snapshot=snapshot,
        )
        self.save(run)
        logger.info("[PlanRunStore] create_run run_id=%s intent=%s", run.run_id, intent)
        return run

    def save(self, run: PlanRunInfo) -> PlanRunInfo:
        path = self._path(run.run_id)
        with self._lock:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(run.model_dump(mode="json"), f, ensure_ascii=False, indent=2)
        return run

    def get(self, run_id: str) -> PlanRunInfo:
        path = self._path(run_id)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Plan run not found: {run_id}")
        with self._lock:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        return PlanRunInfo(**data)

    def set_latest_batch(self, run: PlanRunInfo, batch: ActionBatch) -> PlanRunInfo:
        run.latest_batch = batch
        run.iteration = batch.iteration
        run.pending_action_ids = [a.id for a in batch.actions]
        self.save(run)
        return run

    def clear_pending_actions(self, run: PlanRunInfo) -> PlanRunInfo:
        run.pending_action_ids = []
        self.save(run)
        return run

    def add_action_record(self, run: PlanRunInfo, record: ActionExecutionRecord) -> PlanRunInfo:
        run.action_history.append(record)
        self.save(run)
        return run

    def update_status(self, run: PlanRunInfo, status: str) -> PlanRunInfo:
        run.status = status
        self.save(run)
        return run

    def set_active_action(self, run: PlanRunInfo, action_id: str | None) -> PlanRunInfo:
        run.active_action_id = action_id
        self.save(run)
        return run

    def request_pause(self, run: PlanRunInfo) -> PlanRunInfo:
        run.pause_requested = True
        if run.status == "waiting_user":
            run.status = "paused"
        self.save(run)
        return run

    def clear_pause(self, run: PlanRunInfo) -> PlanRunInfo:
        run.pause_requested = False
        if run.status == "paused":
            run.status = "running"
        self.save(run)
        return run

    def request_cancel(self, run: PlanRunInfo) -> PlanRunInfo:
        run.cancel_requested = True
        if run.status in {"waiting_user", "paused"}:
            run.status = "cancelled"
            run.finished_at = datetime.utcnow().isoformat()
        self.save(run)
        return run

    def mark_run_finished(self, run: PlanRunInfo, status: str) -> PlanRunInfo:
        run.status = status
        run.finished_at = datetime.utcnow().isoformat()
        self.save(run)
        return run

    def mark_run_result(self, run: PlanRunInfo, result: AIResponse | None) -> PlanRunInfo:
        if result is None:
            return run
        run.result_action = result.action
        run.result_content = result.content
        run.result_file_path = result.file_path
        run.result_file_content = result.file_content
        run.result_changes = result.changes or []
        self.save(run)
        return run

    def add_event(
        self,
        run: PlanRunInfo,
        *,
        kind: str,
        stage: str,
        title: str,
        detail: str = "",
        status: str = "info",
        iteration: int | None = None,
        action_id: str | None = None,
        parent_action_id: str | None = None,
        data: dict[str, Any] | None = None,
        input_data: dict[str, Any] | None = None,
        output_data: dict[str, Any] | None = None,
        metrics: dict[str, Any] | None = None,
        artifacts: list[str] | None = None,
        error: str | None = None,
    ) -> PlanRunInfo:
        event = ExecutionEvent(
            event_id=str(uuid.uuid4()),
            kind=kind,
            stage=stage,
            title=title,
            detail=detail,
            status=status,
            timestamp=datetime.utcnow().isoformat(),
            iteration=iteration,
            action_id=action_id,
            parent_action_id=parent_action_id,
            data=data or {},
            input=input_data,
            output=output_data,
            metrics=metrics,
            artifacts=artifacts or [],
            error=error,
        )
        run.events.append(event)
        self.save(run)
        return run

    def _path(self, run_id: str) -> str:
        safe_id = run_id.replace("/", "_")
        return os.path.join(PLAN_RUN_DIR, f"{safe_id}.json")
