import React, { useState, useRef, useEffect } from 'react';
import {
  Send, Bot, User, Sparkles, FileCode,
  Loader2, Settings, Trash2, GitCompare, X, Plus, ListTodo, Play,
} from 'lucide-react';
import type { ChatMessage, AIResponse, Provider, CodeSnippet, PlanBlock } from '../api';

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
  onSend: (message: string, options?: { snippets?: CodeSnippet[]; chatOnly?: boolean; planningMode?: boolean }) => void;
  onClear: () => void;
  activeFile: string | null;
  lastAIResult: AIResponse | null;
  activePlan: PlanBlock | null;
  planRunning: boolean;
  onApplyFile: (path: string, content: string) => void;
  onShowDiff?: (path: string, oldContent: string, newContent: string) => void;
  getCurrentFileContent?: (path: string) => string | undefined;
  onExecutePlan: () => void;
}

function MarkdownContent({ text }: { text: string }) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return (
    <div className="space-y-2">
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const match = part.match(/```(\w*)\n?([\s\S]*?)```/);
          if (match) {
            const [, lang, code] = match;
            return (
              <div key={i} className="relative group">
                {lang && (
                  <div className="text-[10px] text-text-secondary bg-[#2d2d2d] px-2 py-0.5 rounded-t border-b border-border-color">
                    {lang}
                  </div>
                )}
                <pre className={`bg-[#2d2d2d] text-text-primary p-3 overflow-x-auto text-sm ${lang ? 'rounded-b' : 'rounded'}`}>
                  <code>{code.trim()}</code>
                </pre>
              </div>
            );
          }
        }
        return (
          <div key={i} className="whitespace-pre-wrap text-sm leading-relaxed">
            {part.split('\n').map((line, j) => (
              <React.Fragment key={j}>
                {line.startsWith('**') && line.endsWith('**')
                  ? <strong>{line.slice(2, -2)}</strong>
                  : line.startsWith('- ')
                    ? <div className="pl-3">• {line.slice(2)}</div>
                    : line}
                {j < part.split('\n').length - 1 && <br />}
              </React.Fragment>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export default function ChatPanel({
  chatTabs, activeChatId, onChatSelect, onChatCreate, onChatClose,
  draftSnippets, onDraftSnippetsChange,
  messages, loading, providers, currentProvider,
  onProviderChange, onSend, onClear, activeFile,
  lastAIResult, activePlan, planRunning, onApplyFile, onShowDiff, getCurrentFileContent,
  onExecutePlan,
}: Props) {
  const [input, setInput] = useState('');
  const [chatOnly, setChatOnly] = useState(false);
  const [planningMode, setPlanningMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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
      planningMode,
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

        {messages.map((msg, idx) => (
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
              {msg.role === 'assistant' ? <MarkdownContent text={msg.content} /> : (
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
                  {msg.planning_mode && (
                    <div>
                      <span className="inline-flex items-center rounded-md bg-white/15 px-2 py-0.5 text-[11px]">
                        Planning
                      </span>
                    </div>
                  )}
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                </div>
              )}
            </div>
          </div>
        ))}

        {/* File action result - 仅在非仅对话模式下显示 */}
        {!chatOnly && lastAIResult?.action !== 'plan' && lastAIResult?.file_path && lastAIResult?.file_content && (
          <div className="bg-sidebar-bg border border-accent/30 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-3">
              <FileCode size={14} className="text-accent" />
              <span className="text-sm text-accent font-medium">{lastAIResult.file_path}</span>
              <span className="text-[10px] px-1.5 py-0.5 bg-success/20 text-success rounded">
                {lastAIResult.action === 'generate' ? '已生成' : '已修改'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {lastAIResult.action === 'modify' && onShowDiff && getCurrentFileContent && (
                <button
                  onClick={() => {
                    const oldContent = getCurrentFileContent(lastAIResult.file_path!) || '';
                    onShowDiff(lastAIResult.file_path!, oldContent, lastAIResult.file_content!);
                  }}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-sidebar-bg border border-border-color text-text-primary rounded hover:bg-hover-bg transition-colors"
                >
                  <GitCompare size={12} /> 查看对比
                </button>
              )}
              <button
                onClick={() => onApplyFile(lastAIResult.file_path!, lastAIResult.file_content!)}
                className="text-xs px-3 py-1.5 bg-accent text-white rounded hover:bg-accent-hover transition-colors"
              >
                {lastAIResult.action === 'generate' ? '在编辑器中打开' : '直接应用'}
              </button>
            </div>
          </div>
        )}

        {activePlan && (
          <div className="bg-sidebar-bg border border-[#42607f] rounded-lg p-3 space-y-3">
            <div className="flex items-center gap-2">
              <ListTodo size={14} className="text-[#9ec6ff]" />
              <span className="text-sm font-medium text-[#d7e9ff]">Planning（VIP 基础版）</span>
              <button
                onClick={onExecutePlan}
                disabled={loading || planRunning}
                className="ml-auto inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-[#3d5f86] text-white hover:bg-[#4d77a8] disabled:opacity-40 disabled:cursor-not-allowed"
                title="按子计划顺序执行整个计划"
              >
                <Play size={11} />
                {planRunning ? '执行中...' : '执行整个计划'}
              </button>
            </div>

            <div>
              <div className="text-[11px] text-text-secondary mb-1">目标</div>
              <div className="text-sm text-text-primary">{activePlan.summary || '未提供摘要'}</div>
            </div>

            {activePlan.milestones.length > 0 && (
              <div>
                <div className="text-[11px] text-text-secondary mb-1">里程碑</div>
                <div className="space-y-1">
                  {activePlan.milestones.map((m, i) => (
                    <div key={`${m}-${i}`} className="text-sm text-text-primary">• {m}</div>
                  ))}
                </div>
              </div>
            )}

            {activePlan.steps.length > 0 && (
              <div>
                <div className="text-[11px] text-text-secondary mb-1">步骤</div>
                <div className="space-y-2">
                  {activePlan.steps.map((step, i) => (
                    <div key={`${step.title}-${i}`} className="rounded border border-border-color bg-active-bg px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex text-[11px] px-1.5 py-0.5 rounded ${
                          step.status === 'completed'
                            ? 'bg-success/20 text-success'
                            : step.status === 'in_progress'
                              ? 'bg-accent/20 text-accent'
                              : step.status === 'partial'
                                ? 'bg-amber-500/20 text-amber-300'
                              : step.status === 'failed'
                                ? 'bg-red-500/20 text-red-300'
                                : 'bg-white/10 text-text-secondary'
                        }`}>
                          {step.status || 'pending'}
                        </span>
                        <div className="text-sm text-text-primary">{i + 1}. {step.title}</div>
                      </div>
                      {step.detail && <div className="text-xs text-text-secondary mt-1">{step.detail}</div>}
                      {step.acceptance && <div className="text-xs text-success mt-1">验收: {step.acceptance}</div>}
                      {step.summary && (
                        <div className="text-xs text-[#b8d8ff] mt-1 whitespace-pre-wrap">{step.summary}</div>
                      )}
                      {step.error && (
                        <div className="text-xs text-red-300 mt-1">错误: {step.error}</div>
                      )}
                      {step.changes && step.changes.length > 0 && (
                        <div className="mt-2 space-y-1.5">
                          <div className="text-[11px] text-text-secondary">
                            文件变更: {step.changes.filter(c => c.write_result === 'written').length} 成功 / {step.changes.filter(c => c.write_result === 'failed').length} 失败
                          </div>
                          {step.changes.map((change, cIdx) => (
                            <div key={`${change.file_path}-${cIdx}`} className="rounded border border-[#3c4a5a] bg-[#1d232d] px-2 py-1.5">
                              <div className="flex items-center gap-2">
                                <span className={`inline-flex text-[10px] px-1.5 py-0.5 rounded ${
                                  change.write_result === 'written'
                                    ? 'bg-success/20 text-success'
                                    : 'bg-red-500/20 text-red-300'
                                }`}>
                                  {change.write_result}
                                </span>
                                <span className="text-xs text-text-primary font-mono">{change.file_path}</span>
                                {change.before_content !== undefined && change.after_content !== undefined && onShowDiff && (
                                  <button
                                    onClick={() => onShowDiff(change.file_path, change.before_content || '', change.after_content || '')}
                                    className="ml-auto text-[10px] px-2 py-0.5 rounded bg-accent text-white hover:bg-accent-hover"
                                  >
                                    查看 diff
                                  </button>
                                )}
                              </div>
                              {(change.before_hash || change.after_hash) && (
                                <div className="text-[10px] text-text-secondary mt-1 font-mono">
                                  {`before:${(change.before_hash || '').slice(0, 10)} after:${(change.after_hash || '').slice(0, 10)}`}
                                </div>
                              )}
                              {change.error && <div className="text-[10px] text-red-300 mt-1">{change.error}</div>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activePlan.risks.length > 0 && (
              <div>
                <div className="text-[11px] text-text-secondary mb-1">风险</div>
                <div className="space-y-1">
                  {activePlan.risks.map((risk, i) => (
                    <div key={`${risk}-${i}`} className="text-sm text-text-primary">• {risk}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {loading && (
          <div className="flex gap-2">
            <div className="w-7 h-7 rounded-full bg-success/20 flex items-center justify-center flex-shrink-0">
              <Bot size={14} className="text-success" />
            </div>
            <div className="bg-sidebar-bg border border-border-color rounded-lg px-3 py-2 rounded-tl-sm">
              <div className="flex gap-1.5 items-center">
                <Loader2 size={14} className="text-accent animate-spin" />
                <span className="text-sm text-text-secondary">AI 思考中...</span>
              </div>
            </div>
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
                setChatOnly(v => {
                  const next = !v;
                  if (next) setPlanningMode(false);
                  return next;
                });
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
          <label className="flex items-center gap-2 cursor-pointer select-none ml-2">
            <button
              type="button"
              role="switch"
              aria-checked={planningMode}
              onClick={() => {
                setPlanningMode(v => {
                  const next = !v;
                  if (next) setChatOnly(false);
                  return next;
                });
              }}
              className={`relative inline-flex h-5 w-9 items-center rounded-full border p-0 transition-colors ${
                planningMode
                  ? 'bg-[#4d6f95] border-[#6e95c0]'
                  : 'bg-[#3b3b3b] border-[#444]'
              }`}
              title="切换 planning"
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                  planningMode ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
            <span className="text-xs text-text-secondary">Planning(VIP)</span>
          </label>
          {planningMode && (
            <span className="text-[10px] text-text-secondary">（只输出计划，不直接改代码）</span>
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
              planningMode
                ? 'Planning 模式：输入复杂需求，AI 将先输出执行计划'
                : chatOnly
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
