import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, Terminal as TerminalIcon, Trash2, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api } from '../api';

interface TerminalTab {
  id: string;
  title: string;
  sessionId: string | null;
  output: string;
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
    alive: false,
    connecting: true,
    reading: false,
  };
}

export default function TerminalPanel({ onStatus }: Props) {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [createTerminalTab(1)]);
  const [activeTabId, setActiveTabId] = useState('');
  const termHostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pollingRef = useRef<number | null>(null);
  const creatingRef = useRef<Set<string>>(new Set());
  const tabsRef = useRef<TerminalTab[]>(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId) || tabs[0], [tabs, activeTabId]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  const updateTab = (tabId: string, updater: (tab: TerminalTab) => TerminalTab) => {
    setTabs(prev => prev.map(tab => (tab.id === tabId ? updater(tab) : tab)));
  };

  const syncActiveSize = async () => {
    const fit = fitRef.current;
    const term = termRef.current;
    const current = tabsRef.current.find(t => t.id === activeTabIdRef.current);
    if (!fit || !term || !current?.sessionId) return;
    fit.fit();
    if (term.cols > 0 && term.rows > 0) {
      try {
        await api.resizeTerminalSession(current.sessionId, { cols: term.cols, rows: term.rows });
      } catch {
        // Keep terminal usable even if resize RPC fails intermittently.
      }
    }
  };

  useEffect(() => {
    if (!termHostRef.current || termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.3,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
      },
      allowProposedApi: false,
      convertEol: false,
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termHostRef.current);
    fitAddon.fit();
    term.focus();

    const disposable = term.onData((data: string) => {
      const current = tabsRef.current.find(t => t.id === activeTabIdRef.current);
      if (!current?.sessionId || !current.alive) return;
      void api.writeTerminalInput(current.sessionId, data);
    });

    const observer = new ResizeObserver(() => {
      void syncActiveSize();
    });
    observer.observe(termHostRef.current);

    termRef.current = term;
    fitRef.current = fitAddon;

    return () => {
      observer.disconnect();
      disposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  const createSession = async (tabId: string) => {
    updateTab(tabId, tab => ({ ...tab, connecting: true }));
    try {
      const session = await api.createTerminalSession({});
      updateTab(tabId, tab => ({
        ...tab,
        sessionId: session.session_id,
        connecting: false,
        alive: session.alive,
        output: session.output || '',
      }));
      if (tabId === activeTabIdRef.current && termRef.current) {
        termRef.current.reset();
        termRef.current.write(session.output || '');
      }
      await syncActiveSize();
      onStatus?.('终端会话已建立');
    } catch (e: any) {
      updateTab(tabId, tab => ({
        ...tab,
        connecting: false,
        alive: false,
        output: `${tab.output}\r\n[error] ${e.message}\r\n`,
      }));
      onStatus?.(`终端会话创建失败: ${e.message}`);
    }
  };

  useEffect(() => {
    if (!activeTabId && tabs.length > 0) setActiveTabId(tabs[0].id);
  }, [activeTabId, tabs]);

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
    const term = termRef.current;
    if (!term || !activeTab) return;
    term.reset();
    term.write(activeTab.output || '');
    term.focus();
    void syncActiveSize();
  }, [activeTabId]);

  useEffect(() => {
    if (pollingRef.current) window.clearInterval(pollingRef.current);
    pollingRef.current = window.setInterval(() => {
      tabsRef.current.forEach(tab => {
        if (!tab.sessionId || !tab.alive || tab.reading) return;
        updateTab(tab.id, t => ({ ...t, reading: true }));
        api.readTerminalOutput(tab.sessionId)
          .then(res => {
            const chunk = res.output || '';
            updateTab(tab.id, t => ({
              ...t,
              reading: false,
              alive: res.alive,
              output: chunk ? `${t.output}${chunk}` : t.output,
            }));
            if (chunk && tab.id === activeTabIdRef.current && termRef.current) {
              termRef.current.write(chunk);
            }
          })
          .catch(() => {
            updateTab(tab.id, t => ({ ...t, reading: false, alive: false }));
          });
      });
    }, 120);
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

  const clearActive = () => {
    if (!activeTab) return;
    updateTab(activeTab.id, tab => ({ ...tab, output: '' }));
    if (termRef.current) {
      termRef.current.reset();
      termRef.current.focus();
    }
  };

  const restartActive = async () => {
    if (!activeTab) return;
    if (activeTab.sessionId) await api.closeTerminalSession(activeTab.sessionId);
    updateTab(activeTab.id, tab => ({
      ...tab,
      sessionId: null,
      output: '',
      alive: false,
      connecting: true,
    }));
  };

  return (
    <div className="h-full flex flex-col bg-panel-bg border-t border-border-color">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border-color bg-sidebar-bg">
        <div className="flex items-center gap-2 min-w-0 overflow-x-auto">
          <div className="flex items-center gap-1 text-xs text-text-primary px-2">
            <TerminalIcon size={13} className="text-accent" />
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
            onClick={clearActive}
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
      <div ref={termHostRef} className="flex-1 overflow-hidden bg-editor-bg" />
    </div>
  );
}
