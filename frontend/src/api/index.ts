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
}

export interface PlanStep {
  title: string;
  detail?: string;
  status: string;
  acceptance?: string;
  summary?: string;
  error?: string;
  changes?: FileChange[];
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
}

export interface Provider {
  id: string;
  name: string;
  model: string;
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
};
