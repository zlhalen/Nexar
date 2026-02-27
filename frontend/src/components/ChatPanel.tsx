import React, { useState, useRef, useEffect } from 'react';
import {
  Send, Bot, User, Sparkles, FileCode,
  Loader2, Settings, Trash2, GitCompare, X, Plus,
} from 'lucide-react';
import type { ChatMessage, AIResponse, Provider, CodeSnippet } from '../api';

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
  onApplyFile: (path: string, content: string) => void;
  onShowDiff?: (path: string, oldContent: string, newContent: string) => void;
  getCurrentFileContent?: (path: string) => string | undefined;
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
  lastAIResult, onApplyFile, onShowDiff, getCurrentFileContent,
}: Props) {
  const [input, setInput] = useState('');
  const [chatOnly, setChatOnly] = useState(false);
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
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                </div>
              )}
            </div>
          </div>
        ))}

        {/* File action result - 仅在非仅对话模式下显示 */}
        {!chatOnly && lastAIResult?.file_path && lastAIResult?.file_content && (
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
              onClick={() => setChatOnly(v => !v)}
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
                ? '输入消息... (Enter发送, Shift+Enter换行)'
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
