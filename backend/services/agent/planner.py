from __future__ import annotations

import json
from typing import Any

from backend.models.schemas import (
    AIRequestSnapshot,
    ActionBatch,
    ActionBatchDecision,
    ActionExecutionRecord,
    ActionSpec,
    ActionType,
)
from backend.services import ai_service


class PlannerService:
    """LLM planner that outputs a structured ActionBatch."""

    def __init__(self):
        self.available_actions = [t.value for t in ActionType]

    async def plan_next(
        self,
        req: AIRequestSnapshot,
        iteration: int,
        original_user_query: str,
        action_history: list[ActionExecutionRecord],
        context_snapshot: dict[str, Any],
    ) -> ActionBatch:
        batch = await ai_service.plan_actions(
            provider=req.provider,
            request=req,
            iteration=iteration,
            original_user_query=original_user_query,
            action_history=action_history,
            context_snapshot=context_snapshot,
            available_actions=self.available_actions,
        )
        return self._normalize_batch(batch, iteration=iteration, action_history=action_history)

    def fallback_batch(
        self,
        iteration: int,
        reason: str,
    ) -> ActionBatch:
        return ActionBatch(
            iteration=iteration,
            summary="无法可靠规划下一步，等待用户补充信息",
            decision=ActionBatchDecision(mode="ask_user", reason=reason, needs_user_trigger=False, satisfaction_score=0.0),
            actions=[
                ActionSpec(
                    id="a1",
                    type=ActionType.ASK_USER,
                    title="请求补充信息",
                    reason=reason,
                    input={"question": "请补充目标文件、期望结果或允许执行的命令范围。"},
                    success_criteria=["收到用户补充信息"],
                )
            ],
            next_questions=["请提供目标文件路径或功能范围。"],
        )

    def _normalize_batch(
        self,
        batch: ActionBatch,
        iteration: int,
        action_history: list[ActionExecutionRecord],
    ) -> ActionBatch:
        batch.iteration = iteration
        if not batch.actions and batch.decision.mode == "continue":
            batch.decision.mode = "ask_user"
            batch.decision.reason = batch.decision.reason or "planner returned empty actions"
            batch.decision.needs_user_trigger = False
        seen: set[str] = set()
        normalized: list[ActionSpec] = []
        for idx, action in enumerate(batch.actions, start=1):
            if not action.id or action.id in seen:
                action.id = f"a{idx}"
            seen.add(action.id)
            if action.type == ActionType.FINAL_ANSWER:
                batch.decision.mode = "done"
                action.can_parallel = False
            if not action.success_criteria:
                action.success_criteria = ["动作执行完成且输出有效"]
            normalized.append(action)

        normalized = self._ensure_scan_before_discovery(normalized, action_history)
        batch.actions = normalized
        return batch

    def _ensure_scan_before_discovery(
        self,
        actions: list[ActionSpec],
        action_history: list[ActionExecutionRecord],
    ) -> list[ActionSpec]:
        discovery_types = {
            ActionType.SEARCH_CODE,
            ActionType.READ_FILES,
            ActionType.EXTRACT_SYMBOLS,
            ActionType.ANALYZE_DEPENDENCIES,
        }
        needs_discovery = any(a.type in discovery_types for a in actions)
        if not needs_discovery:
            return actions

        has_scanned_before = any(
            rec.action_type == ActionType.SCAN_WORKSPACE and rec.status == "completed"
            for rec in action_history
        )
        scan_action = next((a for a in actions if a.type == ActionType.SCAN_WORKSPACE), None)
        result = list(actions)

        if not has_scanned_before and scan_action is None:
            existing_ids = {a.id for a in result}
            idx = 1
            while f"a{idx}" in existing_ids:
                idx += 1
            scan_action = ActionSpec(
                id=f"a{idx}",
                type=ActionType.SCAN_WORKSPACE,
                title="扫描工作区结构",
                reason="在搜索和读取文件前先建立项目全局索引，降低漏检风险",
                input={"limit": 300},
                can_parallel=False,
                success_criteria=["返回工作区文件列表与文件计数"],
            )
            result.insert(0, scan_action)

        if scan_action is not None:
            for action in result:
                if action.id == scan_action.id:
                    continue
                if action.type in discovery_types and scan_action.id not in action.depends_on:
                    action.depends_on.append(scan_action.id)
                    action.can_parallel = False

        return result


def batch_to_json(batch: ActionBatch) -> str:
    return json.dumps(batch.model_dump(mode="json"), ensure_ascii=False, indent=2)
