import React, { useState, useRef, useEffect } from 'react';
import {
  Send, Bot, User, Sparkles, FileCode, FilePen,
  ChevronDown, Loader2, Settings, Trash2,
} from 'lucide-react';
import type { ChatMessage, AIResponse, Provider } from '../api';

interface Props {
  messages: ChatMessage[];
  loading: boolean;
  providers: Provider[];
  currentProvider: string;
  onProviderChange: (id: string) => void;
  onSend: (message: string, action: string, filePath?: string) => void;
  onClear: () => void;
  activeFile: string | null;
  lastAIResult: AIResponse | null;
  onApplyFile: (path: string, content: string) => void;
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
  messages, loading, providers, currentProvider,
  onProviderChange, onSend, onClear, activeFile,
  lastAIResult, onApplyFile,
}: Props) {
  const [input, setInput] = useState('');
  const [action, setAction] = useState<'chat' | 'generate' | 'modify'>('chat');
  const [filePath, setFilePath] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const handleSend = () => {
    const msg = input.trim();
    if (!msg || loading) return;
    onSend(msg, action, action === 'generate' ? filePath : undefined);
    setInput('');
    setFilePath('');
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
                onClick={() => { setAction('chat'); setInput('帮我解释一下当前代码的作用'); inputRef.current?.focus(); }}
                className="w-full text-left px-3 py-2 bg-sidebar-bg hover:bg-hover-bg rounded border border-border-color"
              >
                💬 解释当前代码
              </button>
              <button
                onClick={() => { setAction('generate'); setInput('生成一个Python Flask API服务'); setFilePath('app.py'); inputRef.current?.focus(); }}
                className="w-full text-left px-3 py-2 bg-sidebar-bg hover:bg-hover-bg rounded border border-border-color"
              >
                ✨ 生成新文件
              </button>
              <button
                onClick={() => { setAction('modify'); setInput('优化当前代码的性能'); inputRef.current?.focus(); }}
                className="w-full text-left px-3 py-2 bg-sidebar-bg hover:bg-hover-bg rounded border border-border-color"
              >
                📝 修改当前文件
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
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              )}
            </div>
          </div>
        ))}

        {/* File action result */}
        {lastAIResult?.file_path && lastAIResult?.file_content && (
          <div className="bg-sidebar-bg border border-accent/30 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <FileCode size={14} className="text-accent" />
              <span className="text-sm text-accent font-medium">{lastAIResult.file_path}</span>
              <span className="text-[10px] px-1.5 py-0.5 bg-success/20 text-success rounded">
                {lastAIResult.action === 'generate' ? '已生成' : '已修改'}
              </span>
            </div>
            <button
              onClick={() => onApplyFile(lastAIResult.file_path!, lastAIResult.file_content!)}
              className="text-xs px-3 py-1 bg-accent text-white rounded hover:bg-accent-hover"
            >
              在编辑器中打开
            </button>
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
        {/* Action Selector */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setAction('chat')}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors
              ${action === 'chat' ? 'bg-accent text-white' : 'bg-active-bg text-text-secondary hover:text-text-primary'}`}
          >
            💬 对话
          </button>
          <button
            onClick={() => setAction('generate')}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors
              ${action === 'generate' ? 'bg-accent text-white' : 'bg-active-bg text-text-secondary hover:text-text-primary'}`}
          >
            <Sparkles size={11} /> 生成
          </button>
          <button
            onClick={() => setAction('modify')}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors
              ${action === 'modify' ? 'bg-accent text-white' : 'bg-active-bg text-text-secondary hover:text-text-primary'}`}
          >
            <FilePen size={11} /> 修改
          </button>
          {activeFile && action === 'modify' && (
            <span className="text-[10px] text-text-secondary ml-1 truncate">
              修改: {activeFile}
            </span>
          )}
        </div>

        {/* Generate file path input */}
        {action === 'generate' && (
          <input
            className="w-full bg-active-bg text-text-primary text-sm px-3 py-1.5 rounded border border-border-color outline-none focus:border-accent"
            placeholder="生成文件路径 (如 src/utils.py)"
            value={filePath}
            onChange={e => setFilePath(e.target.value)}
          />
        )}

        {/* Message input */}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            className="flex-1 bg-active-bg text-text-primary text-sm px-3 py-2 rounded-lg border border-border-color outline-none focus:border-accent resize-none"
            rows={2}
            placeholder={
              action === 'chat' ? '输入消息... (Enter发送, Shift+Enter换行)' :
              action === 'generate' ? '描述你要生成的代码...' :
              '描述你要如何修改当前文件...'
            }
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
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
