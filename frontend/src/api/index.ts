const BASE = '/api';

export interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileItem[];
}

export interface FileContent {
  path: string;
  content: string;
  language?: string;
}

export interface CodeSnippet {
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  snippets?: CodeSnippet[];
  chat_only?: boolean;
  planning_mode?: boolean;
}

export interface HistoryConfig {
  turns: number;
  max_chars_per_message: number;
  summary_enabled: boolean;
  summary_max_chars: number;
}

export interface AIRequest {
  provider: string;
  messages: ChatMessage[];
  current_file?: string;
  current_code?: string;
  file_path?: string;
  range_start?: number;
  range_end?: number;
  snippets?: CodeSnippet[];
  chat_only?: boolean;
  planning_mode?: boolean;
  force_code_edit?: boolean;
  history_config?: HistoryConfig;
}

export type ActionType =
  | 'scan_workspace'
  | 'read_files'
  | 'search_code'
  | 'extract_symbols'
  | 'analyze_dependencies'
  | 'summarize_context'
  | 'propose_subplan'
  | 'run_command'
  | 'run_tests'
  | 'run_lint'
  | 'run_build'
  | 'create_file'
  | 'update_file'
  | 'delete_file'
  | 'move_file'
  | 'apply_patch'
  | 'validate_result'
  | 'ask_user'
  | 'request_approval'
  | 'final_answer'
  | 'report_blocker';

export interface ActionSpec {
  id: string;
  type: ActionType;
  title: string;
  reason: string;
  input: Record<string, any>;
  response?: Record<string, any>;
  depends_on: string[];
  can_parallel: boolean;
  priority: number;
  timeout_sec: number;
  max_retries: number;
  success_criteria: string[];
  artifacts: string[];
}

export interface ActionBatchDecision {
  mode: 'continue' | 'ask_user' | 'done' | 'blocked';
  reason?: string;
  needs_user_trigger: boolean;
  satisfaction_score?: number;
}

export interface ActionBatch {
  version: string;
  iteration: number;
  summary: string;
  decision: ActionBatchDecision;
  actions: ActionSpec[];
  acceptance: string[];
  risks: string[];
  next_questions: string[];
}

export interface PlanStep {
  title: string;
  detail?: string;
  status: string;
  acceptance?: string;
  summary?: string;
  error?: string;
  changes?: FileChange[];
  backend_run_id?: string;
  backend_step_status?: string;
  backend_attempts?: number;
}

export interface PlanBlock {
  summary: string;
  milestones: string[];
  steps: PlanStep[];
  risks: string[];
}

export interface FileChange {
  file_path: string;
  file_content: string;
  before_content?: string;
  after_content?: string;
  diff_unified?: string;
  before_hash?: string;
  after_hash?: string;
  write_result: string;
  error?: string;
}

export interface AIResponse {
  content: string;
  file_path?: string;
  file_content?: string;
  action: string;
  plan?: PlanBlock;
  changes?: FileChange[];
  run?: PlanRunInfo;
  run_id?: string;
  needs_user_trigger?: boolean;
  pending_actions?: ActionSpec[];
}

export interface PlanRunStepInfo {
  index: number;
  name: string;
  kind: string;
  goal: string;
  status: string;
  attempts: number;
  error?: string;
}

export interface ExecutionEvent {
  event_id: string;
  kind?: string;
  stage: string;
  title: string;
  detail?: string;
  status: string;
  timestamp?: string;
  iteration?: number;
  action_id?: string;
  parent_action_id?: string;
  data?: Record<string, any>;
  input?: Record<string, any>;
  output?: Record<string, any>;
  metrics?: Record<string, any>;
  artifacts?: string[];
  error?: string;
}

export interface PlanRunInfo {
  run_id: string;
  intent: string;
  status: string;
  max_retries: number;
  current_step_index: number;
  steps: PlanRunStepInfo[];
  started_at?: string;
  finished_at?: string;
  iteration: number;
  latest_batch?: ActionBatch;
  pending_action_ids: string[];
  pause_requested?: boolean;
  cancel_requested?: boolean;
  active_action_id?: string;
  action_history?: Array<{
    iteration: number;
    action_id: string;
    action_type: ActionType;
    status: string;
    title: string;
    reason: string;
    input: Record<string, any>;
    output: Record<string, any>;
    artifacts: string[];
    error?: string;
  }>;
  result_action?: string;
  result_content?: string;
  result_file_path?: string;
  result_file_content?: string;
  result_changes?: FileChange[];
  events?: ExecutionEvent[];
}

export interface StartRunResponse {
  run_id: string;
}

export interface Provider {
  id: string;
  name: string;
  model: string;
}

export interface TerminalSessionInfo {
  session_id: string;
  cwd: string;
  shell: string;
  alive: boolean;
  exit_code?: number | null;
  output: string;
}

export interface TerminalSessionOutput {
  session_id: string;
  output: string;
  alive: boolean;
  exit_code?: number | null;
}

export interface TerminalSessionResizeRequest {
  cols: number;
  rows: number;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: resp.statusText }));
    throw new Error(err.detail || 'Request failed');
  }
  return resp.json();
}

export const api = {
  getFileTree: (path = '') =>
    request<FileItem[]>(`/files/tree?path=${encodeURIComponent(path)}`),

  readFile: (path: string) =>
    request<FileContent>(`/files/read?path=${encodeURIComponent(path)}`),

  writeFile: (path: string, content: string) =>
    request<FileContent>('/files/write', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),

  createItem: (path: string, is_dir: boolean, content = '') =>
    request<{ success: boolean }>('/files/create', {
      method: 'POST',
      body: JSON.stringify({ path, is_dir, content }),
    }),

  deleteItem: (path: string) =>
    request<{ success: boolean }>('/files/delete', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  renameItem: (old_path: string, new_path: string) =>
    request<{ success: boolean }>('/files/rename', {
      method: 'POST',
      body: JSON.stringify({ old_path, new_path }),
    }),

  chat: (req: AIRequest) =>
    request<AIResponse>('/ai/chat', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  getProviders: () => request<Provider[]>('/ai/providers'),
  getRun: (runId: string) => request<PlanRunInfo>(`/ai/runs/${encodeURIComponent(runId)}`),
  startRun: (req: AIRequest) =>
    request<StartRunResponse>('/ai/runs/start', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
  continueRun: (runId: string) =>
    request<AIResponse>(`/ai/runs/${encodeURIComponent(runId)}/continue`, {
      method: 'POST',
    }),
  replyRun: (runId: string, message: string) =>
    request<AIResponse>(`/ai/runs/${encodeURIComponent(runId)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  pauseRun: (runId: string) =>
    request<PlanRunInfo>(`/ai/runs/${encodeURIComponent(runId)}/pause`, {
      method: 'POST',
    }),
  resumeRun: (runId: string) =>
    request<PlanRunInfo>(`/ai/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST',
    }),
  cancelRun: (runId: string) =>
    request<PlanRunInfo>(`/ai/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }),

  createTerminalSession: (payload?: { cwd?: string; shell?: string }) =>
    request<TerminalSessionInfo>('/terminal/sessions', {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    }),

  writeTerminalInput: (sessionId: string, data: string) =>
    request<{ success: boolean }>(`/terminal/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  readTerminalOutput: (sessionId: string) =>
    request<TerminalSessionOutput>(`/terminal/sessions/${encodeURIComponent(sessionId)}/output`),

  resizeTerminalSession: (sessionId: string, payload: TerminalSessionResizeRequest) =>
    request<{ success: boolean }>(`/terminal/sessions/${encodeURIComponent(sessionId)}/resize`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  closeTerminalSession: (sessionId: string) =>
    request<{ success: boolean }>(`/terminal/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }),
};
