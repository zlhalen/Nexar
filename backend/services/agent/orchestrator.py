from __future__ import annotations

import logging
from datetime import datetime

from backend.models.schemas import (
    AIRequest,
    AIRequestSnapshot,
    AIResponse,
    ActionBatch,
    ActionSpec,
    ActionType,
)
from backend.services.agent.context import ContextSnapshotBuilder
from backend.services.agent.executor import ActionExecutor
from backend.services.agent.planner import PlannerService
from backend.services.plan_run_store import PlanRunStore

logger = logging.getLogger("agent_orchestrator")


class ClosedLoopAgent:
    """Action-driven orchestrator: planning -> actions[] -> planning."""

    def __init__(self):
        self.run_store = PlanRunStore()
        self.context_builder = ContextSnapshotBuilder()
        self.planner = PlannerService()
        self.executor = ActionExecutor()
        self.max_retries = 3

    def create_run(self, req: AIRequest):
        intent = self._infer_intent(req)
        run = self.run_store.create_run(intent=intent, max_retries=self.max_retries, request=req)
        self.run_store.add_event(
            run,
            kind="system",
            stage="run",
            title="任务已创建",
            detail=f"intent={intent}",
            status="completed",
            data={"created_at": datetime.utcnow().isoformat()},
        )
        return run.run_id

    async def execute(self, req: AIRequest) -> AIResponse:
        run_id = self.create_run(req)
        return await self._plan_iteration(run_id)

    async def execute_by_run_id(self, req: AIRequest, run_id: str) -> AIResponse:
        # compatibility with existing route signature
        _ = req
        return await self._plan_iteration(run_id)

    async def continue_run(self, run_id: str) -> AIResponse:
        run = self.run_store.get(run_id)
        if run.status in {"completed", "failed", "blocked", "cancelled"}:
            return self._response_from_run(run, content=run.result_content or "任务已结束", needs_user_trigger=False)
        if run.status == "paused":
            return self._response_from_run(run, content="任务已暂停", needs_user_trigger=False)

        req = self._require_snapshot(run)
        if not run.latest_batch or not run.pending_action_ids:
            return await self._plan_iteration(run_id)

        await self._execute_pending_actions(run_id, req, run.latest_batch)
        run = self.run_store.get(run_id)

        if run.status in {"completed", "failed", "blocked"}:
            return self._response_from_run(run, content=run.result_content or "任务已结束", needs_user_trigger=False)
        if run.status == "paused":
            return self._response_from_run(run, content="任务已暂停", needs_user_trigger=False)
        if run.status == "waiting_user" and run.pending_action_ids:
            summary = run.latest_batch.summary if run.latest_batch else "等待用户确认下一步动作"
            return self._response_from_run(run, content=summary, needs_user_trigger=True)

        return await self._plan_iteration(run_id)

    def pause_run(self, run_id: str):
        run = self.run_store.get(run_id)
        if run.status in {"completed", "failed", "blocked", "cancelled"}:
            return run
        run = self.run_store.request_pause(run)
        run = self.run_store.get(run_id)
        self.run_store.add_event(
            run,
            kind="system",
            stage="control",
            title="请求暂停",
            detail="将在当前动作完成后暂停",
            status="waiting_user",
            data={"active_action_id": run.active_action_id},
        )
        return self.run_store.get(run_id)

    def resume_run(self, run_id: str):
        run = self.run_store.get(run_id)
        if run.status == "cancelled":
            return run
        run = self.run_store.clear_pause(run)
        run = self.run_store.get(run_id)
        self.run_store.add_event(
            run,
            kind="system",
            stage="control",
            title="继续执行",
            detail="已恢复自动执行",
            status="running",
        )
        return self.run_store.get(run_id)

    def cancel_run(self, run_id: str):
        run = self.run_store.get(run_id)
        if run.status in {"completed", "failed", "blocked", "cancelled"}:
            return run
        run = self.run_store.request_cancel(run)
        run = self.run_store.get(run_id)
        if run.active_action_id is None:
            self.run_store.clear_pending_actions(run)
            self.run_store.mark_run_finished(run, status="cancelled")
        run = self.run_store.get(run_id)
        self.run_store.add_event(
            run,
            kind="system",
            stage="control",
            title="取消执行",
            detail="执行流程已取消",
            status="blocked",
        )
        return self.run_store.get(run_id)

    async def _plan_iteration(self, run_id: str) -> AIResponse:
        run = self.run_store.get(run_id)
        if run.cancel_requested:
            self.run_store.clear_pending_actions(run)
            self.run_store.mark_run_finished(run, status="cancelled")
            run = self.run_store.get(run_id)
            return self._response_from_run(run, content="任务已取消", needs_user_trigger=False)
        if run.pause_requested:
            self.run_store.update_status(run, "paused")
            run = self.run_store.get(run_id)
            return self._response_from_run(run, content="任务已暂停", needs_user_trigger=False)
        req = self._require_snapshot(run)
        iteration = run.iteration + 1
        original_query = self._latest_user_query(req)

        self.run_store.add_event(
            run,
            kind="planning",
            stage="planning",
            title=f"第 {iteration} 轮规划",
            detail="规划下一批动作",
            status="running",
            iteration=iteration,
        )

        context_snapshot = self.context_builder.build(req, run.action_history)
        try:
            batch = await self.planner.plan_next(
                req=req,
                iteration=iteration,
                original_user_query=original_query,
                action_history=run.action_history,
                context_snapshot=context_snapshot,
            )
        except Exception as err:
            logger.exception("[ClosedLoopAgent] planner_failed run_id=%s", run_id)
            batch = self.planner.fallback_batch(iteration=iteration, reason=str(err))

        run = self.run_store.get(run_id)
        self.run_store.set_latest_batch(run, batch)

        self.run_store.add_event(
            run,
            kind="planning",
            stage="planning",
            title=f"第 {iteration} 轮规划完成",
            detail=batch.summary,
            status="completed",
            iteration=iteration,
            output_data=batch.model_dump(mode="json"),
            data={"decision": batch.decision.mode, "action_count": len(batch.actions)},
        )

        for action in batch.actions:
            self.run_store.add_event(
                run,
                kind="action",
                stage=action.type.value,
                title=action.title,
                detail=action.reason,
                status="queued",
                iteration=iteration,
                action_id=action.id,
                input_data=action.input,
                data={"depends_on": action.depends_on, "can_parallel": action.can_parallel},
            )

        if batch.decision.mode == "blocked":
            msg = batch.decision.reason or "任务阻塞"
            result = AIResponse(content=msg, action="chat", run_id=run_id, needs_user_trigger=False, pending_actions=[])
            run = self.run_store.get(run_id)
            self.run_store.mark_run_finished(run, status="blocked")
            self.run_store.mark_run_result(run, result)
            return self._response_from_run(self.run_store.get(run_id), content=msg, needs_user_trigger=False)

        if batch.decision.mode == "done" and not batch.actions:
            msg = batch.decision.reason or "任务已完成"
            result = AIResponse(content=msg, action="chat", run_id=run_id, needs_user_trigger=False, pending_actions=[])
            run = self.run_store.get(run_id)
            self.run_store.clear_pending_actions(run)
            self.run_store.mark_run_finished(run, status="completed")
            self.run_store.mark_run_result(run, result)
            return self._response_from_run(self.run_store.get(run_id), content=msg, needs_user_trigger=False)

        waiting = batch.decision.needs_user_trigger and len(batch.actions) > 0
        run = self.run_store.get(run_id)
        if run.pause_requested:
            self.run_store.update_status(run, "paused")
        else:
            self.run_store.update_status(run, "waiting_user" if waiting else "running")
        run = self.run_store.get(run_id)

        return self._response_from_run(
            run,
            content=batch.summary,
            needs_user_trigger=waiting,
            pending_actions=batch.actions,
        )

    async def _execute_pending_actions(self, run_id: str, req: AIRequestSnapshot, batch: ActionBatch) -> None:
        run = self.run_store.get(run_id)
        actions = {a.id: a for a in batch.actions if a.id in set(run.pending_action_ids)}
        execution_order = self._topological_order(list(actions.values()))

        all_file_changes = run.result_changes[:]
        final_answer: str | None = None

        for action in execution_order:
            run = self.run_store.get(run_id)
            if action.id not in run.pending_action_ids:
                continue
            if run.cancel_requested:
                self.run_store.clear_pending_actions(run)
                self.run_store.mark_run_finished(run, status="cancelled")
                run = self.run_store.get(run_id)
                self.run_store.add_event(
                    run,
                    kind="system",
                    stage="finalize",
                    title="执行已取消",
                    detail="已在动作边界停止",
                    status="blocked",
                    iteration=batch.iteration,
                )
                return
            if run.pause_requested:
                self.run_store.update_status(run, "paused")
                run = self.run_store.get(run_id)
                self.run_store.add_event(
                    run,
                    kind="system",
                    stage="control",
                    title="执行已暂停",
                    detail="已在动作边界暂停，可继续恢复",
                    status="waiting_user",
                    iteration=batch.iteration,
                )
                return

            self.run_store.add_event(
                run,
                kind="action",
                stage=action.type.value,
                title=action.title,
                detail=action.reason,
                status="running",
                iteration=batch.iteration,
                action_id=action.id,
                input_data=action.input,
            )
            self.run_store.set_active_action(run, action.id)

            outcome = await self.executor.execute(req=req, action=action, iteration=batch.iteration, history=run.action_history)
            run = self.run_store.get(run_id)
            self.run_store.add_action_record(run, outcome.record)
            run = self.run_store.get(run_id)

            self.run_store.add_event(
                run,
                kind="action",
                stage=action.type.value,
                title=action.title,
                detail=self._action_result_detail(action, outcome.record.status, outcome.record.output, outcome.record.error),
                status=outcome.record.status,
                iteration=batch.iteration,
                action_id=action.id,
                input_data=outcome.record.input,
                output_data=outcome.record.output,
                artifacts=outcome.record.artifacts,
                error=outcome.record.error,
            )

            if outcome.file_changes:
                all_file_changes.extend(outcome.file_changes)
            if outcome.final_answer:
                final_answer = outcome.final_answer

            run.pending_action_ids = [aid for aid in run.pending_action_ids if aid != action.id]
            run.active_action_id = None
            self.run_store.save(run)

            if outcome.blocked or outcome.record.status == "failed":
                run = self.run_store.get(run_id)
                self.run_store.update_status(run, "waiting_user")
                self.run_store.add_event(
                    run,
                    kind="system",
                    stage="iteration_summary",
                    title=f"第 {batch.iteration} 轮中断",
                    detail=outcome.assistant_message or outcome.record.error or "执行中断",
                    status="blocked" if outcome.blocked else "failed",
                    iteration=batch.iteration,
                    data={"action_id": action.id},
                )
                if all_file_changes:
                    partial = AIResponse(
                        content=outcome.assistant_message or "本轮部分动作已执行",
                        action="chat",
                        changes=all_file_changes,
                        file_path=all_file_changes[-1].file_path,
                        file_content=all_file_changes[-1].after_content,
                    )
                    self.run_store.mark_run_result(run, partial)
                return

        run = self.run_store.get(run_id)
        run.active_action_id = None
        self.run_store.save(run)
        self.run_store.clear_pending_actions(run)

        summary_detail = f"本轮执行完成，动作数 {len(execution_order)}"
        self.run_store.add_event(
            run,
            kind="system",
            stage="iteration_summary",
            title=f"第 {batch.iteration} 轮执行完成",
            detail=summary_detail,
            status="completed",
            iteration=batch.iteration,
            data={"executed": len(execution_order)},
        )

        if batch.decision.mode == "done" or final_answer:
            content = final_answer or batch.summary
            result = AIResponse(
                content=content,
                action="chat",
                changes=all_file_changes,
                file_path=all_file_changes[-1].file_path if all_file_changes else None,
                file_content=all_file_changes[-1].after_content if all_file_changes else None,
            )
            run = self.run_store.get(run_id)
            self.run_store.mark_run_finished(run, status="completed")
            self.run_store.mark_run_result(run, result)
            self.run_store.add_event(
                run,
                kind="system",
                stage="finalize",
                title="任务完成",
                detail=content,
                status="completed",
                iteration=batch.iteration,
            )
            return

        if all_file_changes:
            run = self.run_store.get(run_id)
            partial = AIResponse(
                content="本轮动作执行完成，已更新文件。",
                action="chat",
                changes=all_file_changes,
                file_path=all_file_changes[-1].file_path,
                file_content=all_file_changes[-1].after_content,
            )
            self.run_store.mark_run_result(run, partial)

    def _require_snapshot(self, run):
        if not run.request_snapshot:
            raise ValueError("run missing request_snapshot")
        return run.request_snapshot

    def _response_from_run(
        self,
        run,
        *,
        content: str,
        needs_user_trigger: bool,
        pending_actions: list[ActionSpec] | None = None,
    ) -> AIResponse:
        return AIResponse(
            content=content,
            action="chat",
            run_id=run.run_id,
            needs_user_trigger=needs_user_trigger,
            pending_actions=pending_actions or ([] if not run.latest_batch else [a for a in run.latest_batch.actions if a.id in run.pending_action_ids]),
            run=self.run_store.get(run.run_id),
            file_path=run.result_file_path,
            file_content=run.result_file_content,
            changes=run.result_changes,
        )

    def _topological_order(self, actions: list[ActionSpec]) -> list[ActionSpec]:
        action_by_id = {a.id: a for a in actions}
        visited: set[str] = set()
        temp: set[str] = set()
        ordered: list[ActionSpec] = []

        def dfs(aid: str):
            if aid in visited:
                return
            if aid in temp:
                return
            temp.add(aid)
            action = action_by_id[aid]
            for dep in action.depends_on:
                if dep in action_by_id:
                    dfs(dep)
            temp.remove(aid)
            visited.add(aid)
            ordered.append(action)

        for action in actions:
            dfs(action.id)
        return ordered

    def _infer_intent(self, req: AIRequest) -> str:
        text = self._latest_user_query(AIRequestSnapshot(**req.model_dump())).lower()
        if req.force_code_edit:
            return "code_edit"
        if req.chat_only:
            return "qa"
        edit_markers = ("modify", "change", "edit", "fix", "重构", "修改", "修复", "优化", "改")
        if req.current_file or req.file_path or any(m in text for m in edit_markers):
            return "code_edit"
        return "qa"

    def _latest_user_query(self, req: AIRequestSnapshot) -> str:
        for msg in reversed(req.messages):
            if msg.role == "user":
                return msg.content
        return ""

    def _action_result_detail(self, action: ActionSpec, status: str, output: dict, error: str | None) -> str:
        if status in {"failed", "blocked"}:
            return error or "执行失败"

        if action.type == ActionType.READ_FILES:
            files = output.get("files") if isinstance(output, dict) else None
            if isinstance(files, list) and files:
                ok_files = [str(item.get("path")) for item in files if isinstance(item, dict) and item.get("path")]
                return f"读取完成，共 {len(ok_files)} 个文件：{', '.join(ok_files[:6])}" + (" ..." if len(ok_files) > 6 else "")
            return "读取完成，未返回文件内容"

        if action.type == ActionType.SEARCH_CODE:
            query = output.get("query") if isinstance(output, dict) else ""
            matches = output.get("matches") if isinstance(output, dict) else []
            if isinstance(matches, list):
                hit_files = sorted({str(m.get("path")) for m in matches if isinstance(m, dict) and m.get("path")})
                return f"搜索 `{query}` 命中 {len(matches)} 处，涉及 {len(hit_files)} 个文件"
            return f"搜索 `{query}` 完成"

        if action.type == ActionType.SCAN_WORKSPACE:
            file_count = output.get("file_count") if isinstance(output, dict) else None
            files = output.get("files") if isinstance(output, dict) else []
            sample = []
            if isinstance(files, list):
                sample = [str(p) for p in files[:5]]
            sample_text = f"，示例：{', '.join(sample)}" if sample else ""
            return f"扫描完成，发现文件 {file_count if file_count is not None else 'N/A'} 个{sample_text}"

        if action.type == ActionType.ANALYZE_DEPENDENCIES:
            dep_count = output.get("dependency_count") if isinstance(output, dict) else None
            target = output.get("path") if isinstance(output, dict) else None
            return f"依赖分析完成：{target or 'N/A'}，依赖数 {dep_count if dep_count is not None else 'N/A'}"

        if action.type in {ActionType.RUN_COMMAND, ActionType.RUN_TESTS, ActionType.RUN_LINT, ActionType.RUN_BUILD}:
            cmd = output.get("command") if isinstance(output, dict) else ""
            code = output.get("exit_code") if isinstance(output, dict) else None
            return f"命令执行完成：{cmd} (exit={code if code is not None else 'N/A'})"

        if action.type in {ActionType.CREATE_FILE, ActionType.UPDATE_FILE, ActionType.APPLY_PATCH}:
            path = output.get("path") if isinstance(output, dict) else None
            before_len = output.get("before_len") if isinstance(output, dict) else None
            after_len = output.get("after_len") if isinstance(output, dict) else None
            return f"写入完成：{path or 'N/A'} ({before_len}->{after_len} chars)"

        if action.type == ActionType.VALIDATE_RESULT:
            satisfied = output.get("satisfied") if isinstance(output, dict) else None
            reason = output.get("reason") if isinstance(output, dict) else ""
            return f"验收结果：{'满足' if satisfied else '未满足'}，{reason}"

        if action.type == ActionType.FINAL_ANSWER:
            return str(output.get("message") if isinstance(output, dict) else "已生成最终答复")

        return "完成"
