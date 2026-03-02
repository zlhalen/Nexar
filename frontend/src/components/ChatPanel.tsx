import React, { useState, useRef, useEffect } from 'react';
import {
  Send, Bot, User, Sparkles,
  Loader2, Settings, Trash2, GitCompare, X, Plus, Circle, CheckCircle2, XCircle, ChevronRight, ChevronDown,
} from 'lucide-react';
import type { ChatMessage, AIResponse, Provider, CodeSnippet, ExecutionEvent, ActionSpec } from '../api';

interface Props {
  chatTabs: Array<{ id: string; title: string }>;
  activeChatId: string;
  onChatSelect: (id: string) => void;
  onChatCreate: () => void;
  onChatClose: (id: string) => void;
  draftSnippets: CodeSnippet[];
  onDraftSnippetsChange: (snippets: CodeSnippet[]) => void;
  messages: ChatMessage[];
  loading: boolean;
  providers: Provider[];
  currentProvider: string;
  onProviderChange: (id: string) => void;
  onSend: (message: string, options?: { snippets?: CodeSnippet[]; chatOnly?: boolean }) => void;
  onClear: () => void;
  activeFile: string | null;
  lastAIResult: AIResponse | null;
  executionEvents: ExecutionEvent[];
  onApplyFile: (path: string, content: string) => void;
  onShowDiff?: (path: string, oldContent: string, newContent: string) => void;
  getCurrentFileContent?: (path: string) => string | undefined;
  canExecuteAll: boolean;
  pendingActions: ActionSpec[];
  onExecuteAll: () => void;
}

export default function ChatPanel({
  chatTabs, activeChatId, onChatSelect, onChatCreate, onChatClose,
  draftSnippets, onDraftSnippetsChange,
  messages, loading, providers, currentProvider,
  onProviderChange, onSend, onClear, activeFile,
  lastAIResult, executionEvents, onApplyFile, onShowDiff, getCurrentFileContent,
  canExecuteAll, pendingActions, onExecuteAll,
}: Props) {
  const [input, setInput] = useState('');
  const [chatOnly, setChatOnly] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const addSnippets = (incoming: CodeSnippet[]) => {
    const merged = [...draftSnippets];
    for (const s of incoming) {
      const key = `${s.file_path}:${s.start_line}-${s.end_line}:${s.content}`;
      const exists = merged.some(x => `${x.file_path}:${x.start_line}-${x.end_line}:${x.content}` === key);
      if (!exists) merged.push(s);
    }
    onDraftSnippetsChange(merged);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const raw = e.clipboardData.getData('application/x-nexar-snippet');
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      const list: CodeSnippet[] = Array.isArray(parsed) ? parsed : [parsed];
      const valid = list.filter(item =>
        item &&
        typeof item.file_path === 'string' &&
        typeof item.start_line === 'number' &&
        typeof item.end_line === 'number' &&
        typeof item.content === 'string'
      );
      if (valid.length > 0) {
        addSnippets(valid);
        e.preventDefault();
      }
    } catch {
      // Ignore malformed snippet metadata and fallback to normal paste.
    }
  };

  const handleSend = () => {
    const msg = input.trim();
    if (!msg || loading) return;
    onSend(msg, {
      snippets: draftSnippets,
      chatOnly,
    });
    setInput('');
    onDraftSnippetsChange([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const currentProviderInfo = providers.find(p => p.id === currentProvider);
  const sortedEvents = [...executionEvents].sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
    return ta - tb;
  });
  const groupedEvents = new Map<string, ExecutionEvent[]>();
  sortedEvents.forEach(evt => {
    const key = evt.action_id
      ? `a:${evt.iteration || 0}:${evt.action_id}`
      : `s:${evt.iteration || 0}:${evt.kind || 'system'}:${evt.stage}`;
    const list = groupedEvents.get(key) || [];
    list.push(evt);
    groupedEvents.set(key, list);
  });
  const statusRank: Record<string, number> = {
    failed: 6,
    blocked: 5,
    completed: 4,
    waiting_user: 3,
    running: 2,
    queued: 1,
    info: 0,
  };
  const visibleEvents = Array.from(groupedEvents.values()).map(list => {
    return [...list].sort((a, b) => {
      const sa = statusRank[a.status] ?? 0;
      const sb = statusRank[b.status] ?? 0;
      if (sa !== sb) return sb - sa;
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return tb - ta;
    })[0];
  }).sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
    return ta - tb;
  }).filter(evt => evt.stage !== 'iteration_summary');

  const getDisplayText = (evt: ExecutionEvent): { title: string; detail: string } => {
    if (evt.stage === 'planning') {
      if (evt.status === 'running') {
        return {
          title: '规划下一步动作',
          detail: evt.detail || '',
        };
      }
      if (evt.status === 'completed') {
        return {
          title: (evt.detail || '规划完成').trim(),
          detail: '',
        };
      }
    }
    return {
      title: evt.title,
      detail: evt.detail || '',
    };
  };
  const modifiedChanges = (() => {
    const fromChanges = (lastAIResult?.changes || []).filter(ch => ch.write_result === 'written');
    if (fromChanges.length > 0) return fromChanges;
    if (lastAIResult?.file_path && lastAIResult?.file_content) {
      return [{
        file_path: lastAIResult.file_path,
        file_content: lastAIResult.file_content,
        after_content: lastAIResult.file_content,
        write_result: 'written',
      }];
    }
    return [];
  })();

  const EventIcon = ({ status }: { status: string }) => {
    if (status === 'completed') return <CheckCircle2 size={13} className="text-success mt-0.5" />;
    if (status === 'failed') return <XCircle size={13} className="text-red-300 mt-0.5" />;
    if (status === 'running') return <Loader2 size={13} className="text-accent mt-0.5 animate-spin" />;
    if (status === 'queued') return <Circle size={13} className="text-[#8a95a8] mt-0.5" />;
    if (status === 'waiting_user') return <Circle size={13} className="text-[#ffd58a] mt-0.5" />;
    if (status === 'blocked') return <XCircle size={13} className="text-[#ffb38a] mt-0.5" />;
    return <Circle size={13} className="text-text-secondary mt-0.5" />;
  };
  const toggleEvent = (id: string) => {
    setExpandedEvents(prev => ({ ...prev, [id]: !prev[id] }));
  };
  const renderEventDetail = (evt: ExecutionEvent) => {
    const data = evt.data || {};
    const input = evt.input || {};
    const output = evt.output || {};
    if (evt.stage === 'read_files') {
      const files = Array.isArray((output as any).files) ? (output as any).files : [];
      const inputPathsRaw = (input as any).paths || (input as any).file_paths || (input as any).files || (input as any).targets || [];
      const inputPaths = Array.isArray(inputPathsRaw) ? inputPathsRaw : (inputPathsRaw ? [inputPathsRaw] : []);
      return (
        <div className="mt-1 text-[10px] text-[#9fb8d6] leading-4 space-y-1">
          <div className="text-[#b7d7ff]">读取文件</div>
          {(evt.status === 'queued' || evt.status === 'running') && (
            <div className="text-[#ffd58a]">
              {evt.status === 'queued' ? '尚未执行，等待触发' : '执行中，请稍候'}
            </div>
          )}
          {files.length === 0 && evt.status === 'completed' && <div>执行完成，但没有读取到任何文件内容</div>}
          {inputPaths.length > 0 && (
            <div>
              <div className="text-[#b7d7ff]">目标文件</div>
              {inputPaths.map((p: any, i: number) => <div key={`${String(p)}-${i}`}>- {String(p)}</div>)}
            </div>
          )}
          {files.map((f: any, i: number) => (
            <div key={`${f.path || i}-${i}`}>
              <div>- {f.path || 'N/A'} · {typeof f.chars === 'number' ? `${f.chars} chars` : 'N/A'}</div>
              {f.error && <div className="text-red-300">  error: {String(f.error)}</div>}
              {f.content_truncated && <div className="text-[#ffd58a]">  content truncated</div>}
            </div>
          ))}
        </div>
      );
    }
    if (evt.stage === 'search_code') {
      const query = (output as any).query || (input as any).query || '';
      const matches = Array.isArray((output as any).matches) ? (output as any).matches : [];
      const files = Array.from(new Set(matches.map((m: any) => m?.path).filter(Boolean)));
      return (
        <div className="mt-1 text-[10px] text-[#9fb8d6] leading-4 space-y-1">
          <div>query: <span className="text-[#b7d7ff]">{String(query)}</span></div>
          <div>命中: {matches.length} 处 / {files.length} 个文件</div>
          {files.slice(0, 20).map((p, i) => <div key={`${p}-${i}`}>- {String(p)}</div>)}
          {matches.length > 0 && (
            <pre className="bg-[#1b2230] border border-[#334055] rounded p-1 overflow-x-auto whitespace-pre-wrap break-words">
              {matches.slice(0, 8).map((m: any) => `${m.path}:${m.line} ${m.text || ''}`).join('\n')}
            </pre>
          )}
        </div>
      );
    }
    if (evt.stage === 'scan_workspace') {
      const files = Array.isArray((output as any).files) ? (output as any).files : [];
      const count = (output as any).file_count;
      return (
        <div className="mt-1 text-[10px] text-[#9fb8d6] leading-4 space-y-1">
          <div>文件总数(采样): {typeof count === 'number' ? count : files.length}</div>
          {files.slice(0, 40).map((p: string, i: number) => <div key={`${p}-${i}`}>- {p}</div>)}
        </div>
      );
    }
    if (evt.stage === 'analyze_dependencies') {
      const path = (output as any).path || (input as any).path;
      const deps = Array.isArray((output as any).dependencies) ? (output as any).dependencies : [];
      return (
        <div className="mt-1 text-[10px] text-[#9fb8d6] leading-4 space-y-1">
          <div>target: {String(path || 'N/A')}</div>
          <div>dependency_count: {deps.length}</div>
          {deps.slice(0, 30).map((d: string, i: number) => <div key={`${d}-${i}`}>- {d}</div>)}
        </div>
      );
    }
    if (evt.stage === 'run_command' || evt.stage === 'run_tests' || evt.stage === 'run_lint' || evt.stage === 'run_build') {
      const cmd = (output as any).command || (input as any).command || '';
      const code = (output as any).exit_code;
      const stdout = (output as any).stdout;
      const stderr = (output as any).stderr;
      return (
        <div className="mt-1 text-[10px] text-[#9fb8d6] leading-4 space-y-1">
          <div>command: {String(cmd || 'N/A')}</div>
          <div>exit: {code ?? 'N/A'}</div>
          {stdout && (
            <pre className="bg-[#1b2230] border border-[#334055] rounded p-1 overflow-x-auto whitespace-pre-wrap break-words">
              {String(stdout)}
            </pre>
          )}
          {stderr && (
            <pre className="bg-[#1b2230] border border-[#334055] rounded p-1 overflow-x-auto whitespace-pre-wrap break-words text-red-200">
              {String(stderr)}
            </pre>
          )}
        </div>
      );
    }
    if (evt.input || evt.output || evt.error || evt.artifacts || evt.metrics) {
      return (
        <div className="mt-1 text-[10px] text-[#9fb8d6] leading-4 space-y-1">
          {evt.input && (
            <div>
              <div className="text-[#b7d7ff]">input</div>
              <pre className="bg-[#1b2230] border border-[#334055] rounded p-1 overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(evt.input, null, 2)}
              </pre>
            </div>
          )}
          {evt.output && (
            <div>
              <div className="text-[#b7d7ff]">output</div>
              <pre className="bg-[#1b2230] border border-[#334055] rounded p-1 overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(evt.output, null, 2)}
              </pre>
            </div>
          )}
          {evt.metrics && (
            <div>
              <div className="text-[#b7d7ff]">metrics</div>
              <pre className="bg-[#1b2230] border border-[#334055] rounded p-1 overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(evt.metrics, null, 2)}
              </pre>
            </div>
          )}
          {evt.artifacts && evt.artifacts.length > 0 && (
            <div>
              <div className="text-[#b7d7ff]">artifacts</div>
              {evt.artifacts.map((a, i) => <div key={`${a}-${i}`}>- {a}</div>)}
            </div>
          )}
          {evt.error && <div className="text-red-300">error: {evt.error}</div>}
        </div>
      );
    }
    return (
      <pre className="mt-1 text-[10px] leading-4 text-[#9fb8d6] bg-[#1b2230] border border-[#334055] rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
        {JSON.stringify(data, null, 2)}
      </pre>
    );
  };

  return (
    <div className="h-full flex flex-col bg-panel-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-color bg-sidebar-bg">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-accent" />
          <span className="text-sm font-medium text-text-primary">AI 助手</span>
          {currentProviderInfo && (
            <span className="text-[10px] px-1.5 py-0.5 bg-accent/20 text-accent rounded">
              {currentProviderInfo.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onClear} className="p-1 hover:bg-hover-bg rounded" title="清除对话">
            <Trash2 size={14} className="text-text-secondary" />
          </button>
          <button onClick={() => setShowSettings(!showSettings)} className="p-1 hover:bg-hover-bg rounded" title="设置">
            <Settings size={14} className="text-text-secondary" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 px-2 py-1 border-b border-border-color bg-sidebar-bg overflow-x-auto">
        {chatTabs.map(tab => (
          <div
            key={tab.id}
            className={`group flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer border ${
              tab.id === activeChatId
                ? 'bg-accent/20 text-accent border-accent/40'
                : 'bg-active-bg text-text-secondary border-border-color'
            }`}
            onClick={() => onChatSelect(tab.id)}
          >
            <span className="truncate max-w-[100px]">{tab.title}</span>
            {chatTabs.length > 1 && (
              <button
                className="rounded p-0.5 hover:bg-hover-bg"
                onClick={e => { e.stopPropagation(); onChatClose(tab.id); }}
                title="关闭聊天"
              >
                <X size={11} />
              </button>
            )}
          </div>
        ))}
        <button
          className="ml-1 p-1 rounded border border-border-color bg-active-bg text-text-secondary hover:bg-hover-bg"
          onClick={onChatCreate}
          title="新建聊天"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Settings */}
      {showSettings && (
        <div className="px-3 py-2 bg-sidebar-bg border-b border-border-color space-y-2">
          <label className="text-xs text-text-secondary block">AI 模型</label>
          <select
            className="w-full bg-active-bg text-text-primary text-sm px-2 py-1 rounded border border-border-color outline-none"
            value={currentProvider}
            onChange={e => onProviderChange(e.target.value)}
          >
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.name} ({p.model})</option>
            ))}
          </select>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && !loading && (
          <div className="text-center py-12 text-text-secondary">
            <Sparkles size={32} className="mx-auto mb-3 opacity-40" />
            <p className="text-sm mb-4">你好！我是 AI 编程助手</p>
            <div className="space-y-2 text-xs max-w-[220px] mx-auto">
              <button
                onClick={() => { setInput('帮我解释一下当前代码的作用'); inputRef.current?.focus(); }}
                className="w-full text-left px-3 py-2 bg-sidebar-bg hover:bg-hover-bg rounded border border-border-color"
              >
                💬 解释当前代码
              </button>
            </div>
          </div>
        )}

        {messages.filter(msg => msg.role === 'user').map((msg, idx) => (
          <div key={idx} className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0
              ${msg.role === 'user' ? 'bg-accent' : 'bg-success/20'}`}
            >
              {msg.role === 'user'
                ? <User size={14} className="text-white" />
                : <Bot size={14} className="text-success" />}
            </div>
            <div className={`max-w-[85%] px-3 py-2 rounded-lg
              ${msg.role === 'user'
                ? 'bg-accent text-white rounded-tr-sm'
                : 'bg-sidebar-bg text-text-primary rounded-tl-sm border border-border-color'}`}
            >
              <div className="space-y-2">
                {msg.snippets && msg.snippets.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {msg.snippets.map((snippet, sIdx) => (
                      <span
                        key={`${snippet.file_path}-${snippet.start_line}-${snippet.end_line}-${sIdx}`}
                        className="inline-flex items-center rounded-md bg-white/15 px-2 py-0.5 text-[11px]"
                      >
                        {`${snippet.file_path} (${snippet.start_line}-${snippet.end_line})`}
                      </span>
                    ))}
                  </div>
                )}
                {msg.chat_only && (
                  <div>
                    <span className="inline-flex items-center rounded-md bg-white/15 px-2 py-0.5 text-[11px]">
                      仅对话
                    </span>
                  </div>
                )}
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              </div>
            </div>
          </div>
        ))}

        {(visibleEvents.length > 0 || loading) && (
          <div className="bg-sidebar-bg border border-[#3f4c63] rounded-lg p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-[11px] text-[#9ec6ff]">执行流程</div>
              {canExecuteAll && (
                <button
                  onClick={onExecuteAll}
                  disabled={loading}
                  className="text-[11px] px-2 py-1 bg-accent text-white rounded hover:bg-accent-hover transition-colors disabled:opacity-60"
                >
                  执行全部子计划 ({pendingActions.length})
                </button>
              )}
            </div>
            <div className="space-y-2">
              {visibleEvents.map((evt) => (
                <div key={evt.event_id} className="flex gap-2">
                  <EventIcon status={evt.status} />
                  <div className="min-w-0">
                    {(() => {
                      const display = getDisplayText(evt);
                      return (
                        <>
                    <div className="text-xs text-text-primary">
                      {display.title}
                      {typeof evt.iteration === 'number' && (
                        <span className="ml-1 text-[10px] text-text-secondary">iter {evt.iteration}</span>
                      )}
                    </div>
                    {display.detail && (
                      <div className="text-[11px] text-text-secondary whitespace-pre-wrap">{display.detail}</div>
                    )}
                        </>
                      );
                    })()}
                    <div className="text-[10px] text-[#8ba0bd] font-mono">
                      {evt.stage}
                      {evt.timestamp && ` · ${new Date(evt.timestamp).toLocaleTimeString()}`}
                    </div>
                    {evt.data && Object.keys(evt.data).length > 0 && (
                      <div className="mt-1">
                        <button
                          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border-color text-[#9ec6ff] hover:bg-hover-bg"
                          onClick={() => toggleEvent(evt.event_id)}
                        >
                          {expandedEvents[evt.event_id] ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          详情
                        </button>
                        {expandedEvents[evt.event_id] && (
                          renderEventDetail(evt)
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {modifiedChanges.length > 0 && (
              <div className="mt-3 pt-2 border-t border-[#3f4c63]">
                <div className="text-[11px] text-[#9ec6ff] mb-1">代码修改文件</div>
                <div className="space-y-1">
                  {modifiedChanges.map((ch, idx) => (
                    <div key={`${ch.file_path}-${idx}`} className="flex items-center justify-between gap-2">
                      <div className="text-[11px] text-text-secondary truncate">{ch.file_path}</div>
                      <button
                        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border-color text-[#9ec6ff] hover:bg-hover-bg"
                        onClick={() => {
                          const oldContent = ch.before_content ?? (getCurrentFileContent?.(ch.file_path) || '');
                          const newContent = ch.after_content ?? ch.file_content;
                          onShowDiff?.(ch.file_path, oldContent, newContent);
                        }}
                      >
                        <GitCompare size={11} />
                        Diff
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="border-t border-border-color bg-sidebar-bg p-3 space-y-2">
        {/* Chat Only Checkbox */}
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <button
              type="button"
              role="switch"
              aria-checked={chatOnly}
              onClick={() => {
                setChatOnly(v => !v);
              }}
              className={`relative inline-flex h-5 w-9 items-center rounded-full border p-0 transition-colors ${
                chatOnly
                  ? 'bg-accent/70 border-accent/80'
                  : 'bg-[#3b3b3b] border-[#444]'
              }`}
              title="切换仅对话"
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                  chatOnly ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
            <span className="text-xs text-text-secondary">仅对话</span>
          </label>
          {chatOnly && (
            <span className="text-[10px] text-text-secondary">（仅对话模式下不会修改代码）</span>
          )}
        </div>

        {draftSnippets.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11px] text-text-secondary">已引用 snippet（可多选）</div>
            <div className="flex flex-wrap gap-2">
              {draftSnippets.map((snippet, idx) => (
                <div
                  key={`${snippet.file_path}-${snippet.start_line}-${snippet.end_line}-${idx}`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#345075] bg-[#21344d] px-2 py-1 text-xs text-[#dce9ff]"
                >
                  <span>{`${snippet.file_path} (${snippet.start_line}-${snippet.end_line})`}</span>
                  <button
                    className="rounded p-0.5 hover:bg-[#2a4466]"
                    onClick={() => onDraftSnippetsChange(draftSnippets.filter((_, i) => i !== idx))}
                    title="移除片段"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
            <div className="text-[10px] text-text-secondary">
              写“重构这部分/改这几行”会优先修改引用范围；写“参考这段”会把 snippet 当上下文参考
            </div>
          </div>
        )}

        {/* Message input */}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            className="flex-1 bg-active-bg text-text-primary text-sm px-3 py-2 rounded-lg border border-border-color outline-none focus:border-accent resize-none"
            rows={2}
            placeholder={
              chatOnly
                ? '仅对话模式：输入问题（不会改代码）'
                : draftSnippets.length > 0
                  ? '已引用 snippet：可写“重构这部分”或“参考这段分析下”'
                  : '在编辑器复制后粘贴到这里，可自动附带文件与行号片段'
            }
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={loading}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="p-2.5 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
