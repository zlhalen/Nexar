import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, Terminal, Trash2, X } from 'lucide-react';
import { api } from '../api';

interface TerminalTab {
  id: string;
  title: string;
  sessionId: string | null;
  output: string;
  input: string;
  promptDir: string;
  alive: boolean;
  connecting: boolean;
  reading: boolean;
}

interface Props {
  onStatus?: (msg: string) => void;
}

function createTerminalTab(index: number): TerminalTab {
  return {
    id: `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: `终端 ${index}`,
    sessionId: null,
    output: '',
    input: '',
    promptDir: 'workspace',
    alive: false,
    connecting: true,
    reading: false,
  };
}

function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u0007/g, '');
}

function getBaseName(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'workspace';
}

function detectPromptDirFromText(text: string): string | null {
  const trimmed = text.replace(/\r/g, '');
  const match = trimmed.match(/(?:^|\n)([^\s/\n]+)\s\$\s?$/);
  return match ? match[1] : null;
}

export default function TerminalPanel({ onStatus }: Props) {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [createTerminalTab(1)]);
  const [activeTabId, setActiveTabId] = useState('');
  const outputRef = useRef<HTMLDivElement>(null);
  const inputHostRef = useRef<HTMLDivElement>(null);
  const pollingRef = useRef<number | null>(null);
  const creatingRef = useRef<Set<string>>(new Set());
  const tabsRef = useRef<TerminalTab[]>(tabs);
  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId) || tabs[0], [tabs, activeTabId]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    if (!activeTabId && tabs.length > 0) setActiveTabId(tabs[0].id);
  }, [activeTabId, tabs]);

  useEffect(() => {
    inputHostRef.current?.focus();
  }, [activeTabId]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [activeTab?.output, activeTab?.input]);

  const updateTab = (tabId: string, updater: (tab: TerminalTab) => TerminalTab) => {
    setTabs(prev => prev.map(tab => (tab.id === tabId ? updater(tab) : tab)));
  };

  const createSession = async (tabId: string) => {
    updateTab(tabId, tab => ({ ...tab, connecting: true }));
    try {
      const session = await api.createTerminalSession({});
      const cleanOutput = stripAnsi(session.output || '');
      const promptDir = detectPromptDirFromText(cleanOutput) || getBaseName(session.cwd);
      updateTab(tabId, tab => ({
        ...tab,
        sessionId: session.session_id,
        connecting: false,
        alive: session.alive,
        output: cleanOutput,
        promptDir,
      }));
      onStatus?.('终端会话已建立');
    } catch (e: any) {
      updateTab(tabId, tab => ({
        ...tab,
        connecting: false,
        alive: false,
        output: `${tab.output}\n[error] ${e.message}\n`,
      }));
      onStatus?.(`终端会话创建失败: ${e.message}`);
    }
  };

  useEffect(() => {
    tabs.forEach(tab => {
      if (!tab.sessionId && tab.connecting && !creatingRef.current.has(tab.id)) {
        creatingRef.current.add(tab.id);
        void createSession(tab.id).finally(() => {
          creatingRef.current.delete(tab.id);
        });
      }
    });
  }, [tabs]);

  useEffect(() => {
    if (pollingRef.current) window.clearInterval(pollingRef.current);
    pollingRef.current = window.setInterval(() => {
      tabsRef.current.forEach(tab => {
        if (!tab.sessionId || !tab.alive || tab.reading) return;
        updateTab(tab.id, t => ({ ...t, reading: true }));
        api.readTerminalOutput(tab.sessionId)
          .then(res => {
            const chunk = stripAnsi(res.output || '');
            updateTab(tab.id, t => {
              const nextOutput = chunk ? `${t.output}${chunk}` : t.output;
              const promptDir = detectPromptDirFromText(nextOutput) || t.promptDir;
              return {
                ...t,
                reading: false,
                alive: res.alive,
                output: nextOutput,
                promptDir,
              };
            });
          })
          .catch(() => {
            updateTab(tab.id, t => ({ ...t, reading: false, alive: false }));
          });
      });
    }, 200);
    return () => {
      if (pollingRef.current) window.clearInterval(pollingRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      tabsRef.current.forEach(tab => {
        if (tab.sessionId) void api.closeTerminalSession(tab.sessionId);
      });
    };
  }, []);

  const createTab = () => {
    setTabs(prev => {
      const next = createTerminalTab(prev.length + 1);
      setActiveTabId(next.id);
      return [...prev, next];
    });
  };

  const closeTab = (id: string) => {
    setTabs(prev => {
      if (prev.length <= 1) return prev;
      const target = prev.find(t => t.id === id);
      if (target?.sessionId) void api.closeTerminalSession(target.sessionId);
      const next = prev.filter(tab => tab.id !== id);
      setActiveTabId(current => (current === id ? next[next.length - 1].id : current));
      return next;
    });
  };

  const sendInput = async (text: string) => {
    if (!activeTab?.sessionId || !activeTab.alive) return;
    try {
      await api.writeTerminalInput(activeTab.sessionId, text);
    } catch (e: any) {
      updateTab(activeTab.id, tab => ({ ...tab, output: `${tab.output}\n[error] ${e.message}\n` }));
      onStatus?.(`终端输入失败: ${e.message}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!activeTab || !activeTab.alive) return;

    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      if (activeTab.input.length > 0) {
        updateTab(activeTab.id, tab => ({ ...tab, input: '' }));
      } else {
        void sendInput('\u0003');
      }
      return;
    }

    if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      updateTab(activeTab.id, tab => ({ ...tab, output: '' }));
      void sendInput('\u000c');
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const line = activeTab.input;
      if (!line.trim()) {
        void sendInput('\n');
        return;
      }
      updateTab(activeTab.id, tab => ({ ...tab, input: '' }));
      void sendInput(`${line}\n`);
      return;
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      updateTab(activeTab.id, tab => ({ ...tab, input: tab.input.slice(0, -1) }));
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      updateTab(activeTab.id, tab => ({ ...tab, input: `${tab.input}  ` }));
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      e.preventDefault();
      updateTab(activeTab.id, tab => ({ ...tab, input: `${tab.input}${e.key}` }));
    }
  };

  const restartActive = async () => {
    if (!activeTab) return;
    if (activeTab.sessionId) await api.closeTerminalSession(activeTab.sessionId);
    updateTab(activeTab.id, tab => ({
      ...tab,
      sessionId: null,
      output: '',
      input: '',
      alive: false,
      connecting: true,
    }));
  };

  if (!activeTab) return null;

  return (
    <div className="h-full flex flex-col bg-panel-bg border-t border-border-color">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border-color bg-sidebar-bg">
        <div className="flex items-center gap-2 min-w-0 overflow-x-auto">
          <div className="flex items-center gap-1 text-xs text-text-primary px-2">
            <Terminal size={13} className="text-accent" />
            <span>控制台</span>
          </div>
          {tabs.map(tab => (
            <div
              key={tab.id}
              className={`group flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer border ${
                tab.id === activeTabId
                  ? 'bg-accent/20 text-accent border-accent/40'
                  : 'bg-active-bg text-text-secondary border-border-color'
              }`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span className="truncate max-w-[120px]">{tab.title}</span>
              {tab.connecting && <Loader2 size={10} className="animate-spin" />}
              {tabs.length > 1 && (
                <button
                  className="rounded p-0.5 hover:bg-hover-bg"
                  onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                  title="关闭终端"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          ))}
          <button
            className="p-1 rounded border border-border-color bg-active-bg text-text-secondary hover:bg-hover-bg"
            onClick={createTab}
            title="新建终端"
          >
            <Plus size={12} />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="p-1 rounded hover:bg-hover-bg text-text-secondary"
            onClick={() => updateTab(activeTab.id, tab => ({ ...tab, output: '' }))}
            title="清空输出"
          >
            <Trash2 size={13} />
          </button>
          <button
            className="px-2 py-1 text-[11px] rounded bg-active-bg border border-border-color hover:bg-hover-bg"
            onClick={restartActive}
            title="重启终端"
          >
            重启
          </button>
        </div>
      </div>

      <div
        ref={outputRef}
        className="flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-5 bg-editor-bg text-text-primary whitespace-pre-wrap break-words cursor-text"
        onClick={() => inputHostRef.current?.focus()}
      >
        <pre className="whitespace-pre-wrap break-words">{activeTab.output || (activeTab.connecting ? '正在连接终端...\n' : '')}</pre>
        <div className="flex items-center">
          <span className="text-success">{activeTab.promptDir} $ </span>
          <span>{activeTab.input}</span>
          <span className="ml-[1px] inline-block h-4 w-[7px] bg-text-primary animate-pulse" />
        </div>
      </div>

      <div
        ref={inputHostRef}
        tabIndex={0}
        className="h-0 w-0 outline-none"
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
