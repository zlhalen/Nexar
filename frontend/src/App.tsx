import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Terminal, Bot, Settings,
} from 'lucide-react';
import FileTree from './components/FileTree';
import CodeEditor from './components/CodeEditor';
import ChatPanel from './components/ChatPanel';
import DiffView from './components/DiffView';
import TerminalPanel from './components/TerminalPanel';
import SettingsPage from './components/SettingsPage';
import { api } from './api';
import type {
  FileItem, ChatMessage, AIResponse, Provider, CodeSnippet, ExecutionEvent, ActionSpec, HistoryConfig,
} from './api';

interface OpenFile {
  path: string;
  content: string;
  language: string;
  modified: boolean;
}

interface SendOptions {
  snippets?: CodeSnippet[];
  chatOnly?: boolean;
}

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  lastAIResult: AIResponse | null;
  executionEvents: ExecutionEvent[];
  draftSnippets: CodeSnippet[];
  runId?: string;
  needsUserTrigger: boolean;
  pendingActions: ActionSpec[];
  runStatus?: string;
}

function createChatSession(index: number): ChatSession {
  return {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: `Chat ${index}`,
    messages: [],
    lastAIResult: null,
    executionEvents: [],
    draftSnippets: [],
    runId: undefined,
    needsUserTrigger: false,
    pendingActions: [],
    runStatus: undefined,
  };
}

function mergeSnippets(prev: CodeSnippet[], incoming: CodeSnippet[]): CodeSnippet[] {
  const merged = [...prev];
  for (const s of incoming) {
    const key = `${s.file_path}:${s.start_line}-${s.end_line}:${s.content}`;
    const exists = merged.some(x => `${x.file_path}:${x.start_line}-${x.end_line}:${x.content}` === key);
    if (!exists) merged.push(s);
  }
  return merged;
}

function mergeExecutionEvents(prev: ExecutionEvent[], incoming: ExecutionEvent[]): ExecutionEvent[] {
  if (!incoming || incoming.length === 0) return prev;
  if (!prev || prev.length === 0) return incoming.slice();
  const byId = new Map<string, ExecutionEvent>();
  for (const evt of prev) byId.set(evt.event_id, evt);
  for (const evt of incoming) byId.set(evt.event_id, evt);
  const incomingHasRealEvents = incoming.some(
    evt => !(evt.stage === 'planning' && evt.status === 'running' && !!(evt.data as any)?.temporary)
  );
  const merged = Array.from(byId.values()).filter(evt => (
    !incomingHasRealEvents || !(evt.stage === 'planning' && evt.status === 'running' && !!(evt.data as any)?.temporary)
  ));
  return merged.sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
    if (ta !== tb) return ta - tb;
    return a.event_id.localeCompare(b.event_id);
  });
}

function getDefaultChatWidth(): number {
  if (typeof window === 'undefined') return 380;
  const sidebarDefaultWidth = 240;
  const splitterWidth = 1;
  const availableMainWidth = window.innerWidth - sidebarDefaultWidth - splitterWidth;
  return Math.max(280, Math.floor(availableMainWidth / 2));
}

const HISTORY_CONFIG_STORAGE_KEY = 'nexar.history_config.v1';
const DEFAULT_HISTORY_CONFIG: HistoryConfig = {
  turns: 40,
  max_chars_per_message: 4000,
  summary_enabled: true,
  summary_max_chars: 1200,
};

export default function App() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showChat, setShowChat] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(256);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [chatWidth, setChatWidth] = useState(() => getDefaultChatWidth());
  const [resizing, setResizing] = useState<{
    panel: 'sidebar' | 'chat';
    startX: number;
    startWidth: number;
  } | null>(null);
  const [terminalResizing, setTerminalResizing] = useState<{
    startY: number;
    startHeight: number;
  } | null>(null);
  const [chats, setChats] = useState<ChatSession[]>(() => [createChatSession(1)]);
  const [activeChatId, setActiveChatId] = useState<string>('');
  const [aiLoading, setAiLoading] = useState(false);
  const [runControlLoading, setRunControlLoading] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [currentProvider, setCurrentProvider] = useState('openai');
  const [historyConfig, setHistoryConfig] = useState<HistoryConfig>(DEFAULT_HISTORY_CONFIG);
  const [statusMsg, setStatusMsg] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [showSettingsPage, setShowSettingsPage] = useState(false);
  const [diffData, setDiffData] = useState<{
    path: string;
    oldContent: string;
    newContent: string;
    language: string;
  } | null>(null);
  const openFilesRef = useRef<OpenFile[]>([]);
  const autoSaveTimersRef = useRef<Record<string, number>>({});
  const runPollersRef = useRef<Record<string, boolean>>({});
  const runDriversRef = useRef<Record<string, boolean>>({});

  const showStatus = useCallback((msg: string, duration = 3000) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(''), duration);
  }, []);

  const loadFileTree = useCallback(async () => {
    try {
      const tree = await api.getFileTree();
      setFiles(tree);
    } catch (e: any) {
      showStatus(`加载文件树失败: ${e.message}`);
    }
  }, [showStatus]);

  const loadProviders = useCallback(async () => {
    try {
      const list = await api.getProviders();
      setProviders(list);
      if (list.length > 0) setCurrentProvider(list[0].id);
    } catch {
      setProviders([{ id: 'openai', name: 'OpenAI', model: 'gpt-4o' }]);
    }
  }, []);

  useEffect(() => {
    loadFileTree();
    loadProviders();
  }, [loadFileTree, loadProviders]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_CONFIG_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.turns === 'number' &&
        typeof parsed.max_chars_per_message === 'number' &&
        typeof parsed.summary_enabled === 'boolean' &&
        typeof parsed.summary_max_chars === 'number'
      ) {
        setHistoryConfig({
          turns: parsed.turns,
          max_chars_per_message: parsed.max_chars_per_message,
          summary_enabled: parsed.summary_enabled,
          summary_max_chars: parsed.summary_max_chars,
        });
      }
    } catch {
      // ignore broken local settings
    }
  }, []);

  const updateHistoryConfig = useCallback((cfg: HistoryConfig) => {
    setHistoryConfig(cfg);
    localStorage.setItem(HISTORY_CONFIG_STORAGE_KEY, JSON.stringify(cfg));
    showStatus('历史会话配置已保存');
  }, [showStatus]);

  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  useEffect(() => () => {
    Object.values(autoSaveTimersRef.current).forEach(id => window.clearTimeout(id));
  }, []);

  useEffect(() => () => {
    Object.keys(runPollersRef.current).forEach(key => {
      runPollersRef.current[key] = false;
    });
    Object.keys(runDriversRef.current).forEach(key => {
      runDriversRef.current[key] = false;
    });
  }, []);

  useEffect(() => {
    if (!activeChatId && chats.length > 0) {
      setActiveChatId(chats[0].id);
    }
  }, [activeChatId, chats]);

  useEffect(() => {
    if (!resizing) return;

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - resizing.startX;
      if (resizing.panel === 'sidebar') {
        const max = Math.max(220, Math.floor(window.innerWidth * 0.45));
        const next = Math.min(max, Math.max(180, resizing.startWidth + delta));
        setSidebarWidth(next);
      } else {
        const max = Math.max(320, Math.floor(window.innerWidth * 0.6));
        const next = Math.min(max, Math.max(280, resizing.startWidth - delta));
        setChatWidth(next);
      }
    };

    const onMouseUp = () => setResizing(null);

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [resizing]);

  useEffect(() => {
    if (!terminalResizing) return;

    const onMouseMove = (e: MouseEvent) => {
      const delta = terminalResizing.startY - e.clientY;
      const max = Math.max(220, Math.floor(window.innerHeight * 0.7));
      const next = Math.min(max, Math.max(120, terminalResizing.startHeight + delta));
      setTerminalHeight(next);
    };

    const onMouseUp = () => setTerminalResizing(null);

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [terminalResizing]);

  const openFile = useCallback(async (path: string) => {
    const existing = openFiles.find(f => f.path === path);
    if (existing) {
      setActiveFile(path);
      return;
    }
    try {
      const data = await api.readFile(path);
      setOpenFiles(prev => [...prev, {
        path: data.path,
        content: data.content,
        language: data.language || 'plaintext',
        modified: false,
      }]);
      setActiveFile(path);
    } catch (e: any) {
      showStatus(`打开文件失败: ${e.message}`);
    }
  }, [openFiles, showStatus]);

  const flushAutoSave = useCallback(async (path: string) => {
    const file = openFilesRef.current.find(f => f.path === path);
    if (!file || !file.modified) return;
    try {
      await api.writeFile(path, file.content);
    } catch (e: any) {
      showStatus(`自动保存失败: ${e.message}`);
    }
  }, [showStatus]);

  const scheduleAutoSave = useCallback((path: string, content: string) => {
    const oldTimer = autoSaveTimersRef.current[path];
    if (oldTimer) {
      window.clearTimeout(oldTimer);
      delete autoSaveTimersRef.current[path];
    }
    autoSaveTimersRef.current[path] = window.setTimeout(async () => {
      try {
        await api.writeFile(path, content);
        setOpenFiles(prev => prev.map(f => (
          f.path === path && f.content === content
            ? { ...f, modified: false }
            : f
        )));
      } catch (e: any) {
        showStatus(`自动保存失败: ${e.message}`);
      } finally {
        delete autoSaveTimersRef.current[path];
      }
    }, 600);
  }, [showStatus]);

  const closeFile = useCallback((path: string) => {
    const oldTimer = autoSaveTimersRef.current[path];
    if (oldTimer) {
      window.clearTimeout(oldTimer);
      delete autoSaveTimersRef.current[path];
    }
    void flushAutoSave(path);
    setOpenFiles(prev => prev.filter(f => f.path !== path));
    if (activeFile === path) {
      const remaining = openFiles.filter(f => f.path !== path);
      setActiveFile(remaining.length > 0 ? remaining[remaining.length - 1].path : null);
    }
  }, [openFiles, activeFile, flushAutoSave]);

  const updateContent = useCallback((path: string, content: string) => {
    setOpenFiles(prev => prev.map(f =>
      f.path === path ? { ...f, content, modified: true } : f
    ));
    scheduleAutoSave(path, content);
  }, [scheduleAutoSave]);

  const saveFile = useCallback(async (path: string) => {
    const file = openFiles.find(f => f.path === path);
    if (!file) return;
    try {
      await api.writeFile(path, file.content);
      setOpenFiles(prev => prev.map(f =>
        f.path === path ? { ...f, modified: false } : f
      ));
      showStatus(`已保存 ${path}`);
    } catch (e: any) {
      showStatus(`保存失败: ${e.message}`);
    }
  }, [openFiles, showStatus]);

  const createItem = useCallback(async (path: string, isDir: boolean) => {
    try {
      await api.createItem(path, isDir);
      await loadFileTree();
      if (!isDir) openFile(path);
      showStatus(`已创建 ${path}`);
    } catch (e: any) {
      showStatus(`创建失败: ${e.message}`);
    }
  }, [loadFileTree, openFile, showStatus]);

  const deleteItem = useCallback(async (path: string) => {
    try {
      Object.keys(autoSaveTimersRef.current).forEach(key => {
        if (key === path || key.startsWith(`${path}/`)) {
          window.clearTimeout(autoSaveTimersRef.current[key]);
          delete autoSaveTimersRef.current[key];
        }
      });
      await api.deleteItem(path);
      setOpenFiles(prev => prev.filter(f => !f.path.startsWith(path)));
      if (activeFile?.startsWith(path)) {
        const remaining = openFiles.filter(f => !f.path.startsWith(path));
        setActiveFile(remaining.length > 0 ? remaining[remaining.length - 1].path : null);
      }
      await loadFileTree();
      showStatus(`已删除 ${path}`);
    } catch (e: any) {
      showStatus(`删除失败: ${e.message}`);
    }
  }, [loadFileTree, openFiles, activeFile, showStatus]);

  const renameItem = useCallback(async (oldPath: string, newPath: string) => {
    try {
      const oldTimer = autoSaveTimersRef.current[oldPath];
      if (oldTimer) {
        window.clearTimeout(oldTimer);
        delete autoSaveTimersRef.current[oldPath];
      }
      await api.renameItem(oldPath, newPath);
      setOpenFiles(prev => prev.map(f =>
        f.path === oldPath ? { ...f, path: newPath } : f
      ));
      if (activeFile === oldPath) setActiveFile(newPath);
      await loadFileTree();
      showStatus(`已重命名 ${oldPath} → ${newPath}`);
    } catch (e: any) {
      showStatus(`重命名失败: ${e.message}`);
    }
  }, [loadFileTree, activeFile, showStatus]);

  const getCurrentFileContent = useCallback((path: string): string | undefined => {
    const file = openFiles.find(f => f.path === path);
    return file?.content;
  }, [openFiles]);

  const showDiffView = useCallback((path: string, oldContent: string, newContent: string) => {
    const file = openFiles.find(f => f.path === path);
    const ext = path.split('.').pop() || '';
    const langMap: Record<string, string> = {
      py: 'python', js: 'javascript', ts: 'typescript', tsx: 'typescriptreact',
      jsx: 'javascriptreact', html: 'html', css: 'css', json: 'json',
      md: 'markdown', go: 'go', rs: 'rust', java: 'java',
    };
    setDiffData({
      path,
      oldContent,
      newContent,
      language: file?.language || langMap[ext] || 'plaintext',
    });
    setShowDiff(true);
  }, [openFiles]);

  const applyFile = useCallback(async (path: string, content: string) => {
    const existing = openFiles.find(f => f.path === path);
    if (existing) {
      setOpenFiles(prev => prev.map(f =>
        f.path === path ? { ...f, content, modified: false } : f
      ));
    } else {
      const ext = path.split('.').pop() || '';
      const langMap: Record<string, string> = {
        py: 'python', js: 'javascript', ts: 'typescript', tsx: 'typescriptreact',
        jsx: 'javascriptreact', html: 'html', css: 'css', json: 'json',
        md: 'markdown', go: 'go', rs: 'rust', java: 'java',
      };
      setOpenFiles(prev => [...prev, {
        path, content, language: langMap[ext] || 'plaintext', modified: false,
      }]);
    }
    setActiveFile(path);
  }, [openFiles]);

  const activeChat = chats.find(c => c.id === activeChatId) || chats[0];

  const createChatTab = useCallback((initialSnippets?: CodeSnippet[]) => {
    const next = createChatSession(chats.length + 1);
    if (initialSnippets && initialSnippets.length > 0) {
      next.draftSnippets = mergeSnippets([], initialSnippets);
    }
    setChats(prev => [...prev, next]);
    setActiveChatId(next.id);
  }, [chats.length]);

  const closeChatTab = useCallback((id: string) => {
    setChats(prev => {
      if (prev.length <= 1) return prev;
      const next = prev.filter(c => c.id !== id);
      setActiveChatId(current => {
        if (current !== id) return current;
        return next[next.length - 1]?.id || '';
      });
      return next;
    });
  }, []);

  const clearActiveChat = useCallback(() => {
    if (!activeChatId) return;
    setChats(prev => prev.map(chat =>
      chat.id === activeChatId
        ? {
          ...chat, messages: [], lastAIResult: null, executionEvents: [], draftSnippets: [],
          runId: undefined, needsUserTrigger: false, pendingActions: [], runStatus: undefined,
        }
        : chat
    ));
  }, [activeChatId]);

  const setActiveChatDraftSnippets = useCallback((snippets: CodeSnippet[]) => {
    if (!activeChatId) return;
    setChats(prev => prev.map(chat =>
      chat.id === activeChatId ? { ...chat, draftSnippets: snippets } : chat
    ));
  }, [activeChatId]);

  const addSnippetToCurrentChat = useCallback((snippet: CodeSnippet) => {
    if (!activeChatId) return;
    setChats(prev => prev.map(chat =>
      chat.id === activeChatId
        ? { ...chat, draftSnippets: mergeSnippets(chat.draftSnippets, [snippet]) }
        : chat
    ));
  }, [activeChatId]);

  const addSnippetToNewChat = useCallback((snippet: CodeSnippet) => {
    createChatTab([snippet]);
  }, [createChatTab]);

  const syncRunIntoChat = useCallback((chatId: string, run: any) => {
    setChats(prev => prev.map(chat =>
      chat.id === chatId
        ? {
          ...chat,
          executionEvents: mergeExecutionEvents(chat.executionEvents, run.events || []),
          pendingActions: (run.latest_batch?.actions || []).filter((a: ActionSpec) => (run.pending_action_ids || []).includes(a.id)),
          needsUserTrigger: (run.pending_action_ids || []).length > 0 && run.status === 'waiting_user',
          runId: run.run_id || chat.runId,
          runStatus: run.status || chat.runStatus,
        }
        : chat
    ));
  }, []);

  const startAutoRun = useCallback(async (chatId: string, runId: string) => {
    if (!runId || runDriversRef.current[runId]) return;
    runDriversRef.current[runId] = true;
    setAiLoading(true);
    try {
      while (runDriversRef.current[runId]) {
        let runSnapshot: any;
        try {
          runSnapshot = await api.getRun(runId);
          syncRunIntoChat(chatId, runSnapshot);
        } catch {
          break;
        }

        const status = runSnapshot.status;
        const decisionMode = runSnapshot.latest_batch?.decision?.mode;
        if (['completed', 'failed', 'blocked', 'cancelled', 'paused'].includes(status)) break;
        if (status === 'waiting_user' && (decisionMode === 'ask_user' || decisionMode === 'blocked')) break;

        const continuePromise = api.continueRun(runId);
        let settled = false;
        continuePromise.finally(() => { settled = true; });

        runPollersRef.current[runId] = true;
        while (runDriversRef.current[runId] && !settled) {
          try {
            const live = await api.getRun(runId);
            syncRunIntoChat(chatId, live);
          } catch {
            // ignore transient polling errors
          }
          await new Promise(resolve => setTimeout(resolve, 450));
        }
        runPollersRef.current[runId] = false;
        if (!runDriversRef.current[runId]) break;

        let result: AIResponse;
        try {
          result = await continuePromise;
        } catch (e: any) {
          const errMsg: ChatMessage = { role: 'assistant', content: `❌ 错误: ${e.message}` };
          setChats(prev => prev.map(chat =>
            chat.id === chatId ? { ...chat, messages: [...chat.messages, errMsg] } : chat
          ));
          break;
        }

        const runStatus = result.run?.status;
        const runMode = result.run?.latest_batch?.decision?.mode;
        const hasFinalAnswerAction = (result.run?.latest_batch?.actions || []).some(a => a.type === 'final_answer');
        const shouldAppendAssistant = !!result.content?.trim() && hasFinalAnswerAction;

        setChats(prev => prev.map(chat =>
          chat.id === chatId
            ? {
              ...chat,
              messages: (() => {
                if (!shouldAppendAssistant) return chat.messages;
                const last = chat.messages[chat.messages.length - 1];
                if (last?.role === 'assistant' && last.content === result.content) return chat.messages;
                return [...chat.messages, { role: 'assistant', content: result.content }];
              })(),
              lastAIResult: result,
              executionEvents: mergeExecutionEvents(chat.executionEvents, result.run?.events || []),
              runId: result.run_id || result.run?.run_id || chat.runId,
              needsUserTrigger: result.needs_user_trigger === true,
              pendingActions: result.pending_actions || [],
              runStatus: result.run?.status || chat.runStatus,
            }
            : chat
        ));

        if (result.file_path && result.file_content) {
          await loadFileTree();
        }

        if (runStatus && ['completed', 'failed', 'blocked', 'cancelled', 'paused'].includes(runStatus)) break;
        if (runStatus === 'waiting_user' && (runMode === 'ask_user' || runMode === 'blocked')) break;
      }
    } finally {
      runPollersRef.current[runId] = false;
      runDriversRef.current[runId] = false;
      setAiLoading(false);
    }
  }, [loadFileTree, syncRunIntoChat]);

  const sendMessage = useCallback(async (text: string, options?: SendOptions) => {
    if (!activeChatId) return;
    const targetChat = chats.find(c => c.id === activeChatId);
    if (!targetChat) return;
    if (targetChat.runId) {
      runDriversRef.current[targetChat.runId] = false;
      runPollersRef.current[targetChat.runId] = false;
    }

    const userMsg: ChatMessage = {
      role: 'user',
      content: text,
      snippets: options?.snippets && options.snippets.length > 0 ? options.snippets : undefined,
      chat_only: options?.chatOnly === true,
    };
    const newMessages = [...targetChat.messages, userMsg];
    setChats(prev => prev.map(chat =>
      chat.id === activeChatId
        ? { ...chat, messages: newMessages }
        : chat
    ));
    setAiLoading(true);
    const creatingEvent: ExecutionEvent = {
      event_id: `tmp-create-${Date.now()}`,
      kind: 'planning',
      stage: 'planning',
      title: '规划下一步动作',
      detail: '正在初始化执行上下文',
      status: 'running',
      timestamp: new Date().toISOString(),
      iteration: 0,
      data: { temporary: true },
    };
    setChats(prev => prev.map(chat =>
      chat.id === activeChatId
        ? {
          ...chat,
          lastAIResult: null,
          executionEvents: mergeExecutionEvents(chat.executionEvents, [creatingEvent]),
          runId: undefined,
          runStatus: 'running',
          pendingActions: [],
          needsUserTrigger: false,
        }
        : chat
    ));

    const currentFileObj = openFiles.find(f => f.path === activeFile);

    let launchedAutoRun = false;
    try {
      const result = await api.chat({
        provider: currentProvider,
        messages: newMessages,
        current_file: activeFile || undefined,
        current_code: currentFileObj?.content,
        snippets: options?.snippets,
        chat_only: options?.chatOnly === true,
        history_config: historyConfig,
      });

      setChats(prev => prev.map(chat =>
        chat.id === activeChatId
          ? {
              ...chat,
              messages: chat.messages,
              lastAIResult: result,
              executionEvents: mergeExecutionEvents(chat.executionEvents, result.run?.events || []),
              draftSnippets: [],
              runId: result.run_id || result.run?.run_id || chat.runId,
              needsUserTrigger: result.needs_user_trigger === true,
              pendingActions: result.pending_actions || [],
              runStatus: result.run?.status || chat.runStatus,
            }
          : chat
      ));

      if (result.file_path && result.file_content) {
        await loadFileTree();
        showStatus(`AI ${result.action === 'generate' ? '生成' : '修改'}了文件: ${result.file_path}`);
        
        // 如果是修改操作，自动显示对比界面
        if (result.action === 'modify' && result.file_path) {
          const file = openFiles.find(f => f.path === result.file_path);
          const oldContent = file?.content || '';
          if (oldContent !== result.file_content) {
            const ext = result.file_path.split('.').pop() || '';
            const langMap: Record<string, string> = {
              py: 'python', js: 'javascript', ts: 'typescript', tsx: 'typescriptreact',
              jsx: 'javascriptreact', html: 'html', css: 'css', json: 'json',
              md: 'markdown', go: 'go', rs: 'rust', java: 'java',
            };
            setDiffData({
              path: result.file_path,
              oldContent,
              newContent: result.file_content,
              language: file?.language || langMap[ext] || 'plaintext',
            });
            setShowDiff(true);
          }
        }
      }
      const runId = result.run_id || result.run?.run_id;
      if (runId) {
        launchedAutoRun = true;
        void startAutoRun(activeChatId, runId);
      }
    } catch (e: any) {
      const errMsg: ChatMessage = { role: 'assistant', content: `❌ 错误: ${e.message}` };
      setChats(prev => prev.map(chat =>
        chat.id === activeChatId
          ? { ...chat, messages: [...chat.messages, errMsg] }
          : chat
      ));
    } finally {
      if (!launchedAutoRun) setAiLoading(false);
    }
  }, [activeChatId, chats, currentProvider, activeFile, openFiles, loadFileTree, showStatus, startAutoRun, historyConfig]);

  const pauseActiveRun = useCallback(async () => {
    const target = chats.find(c => c.id === activeChatId);
    if (!target?.runId) {
      showStatus('当前没有可暂停的任务');
      return;
    }
    runDriversRef.current[target.runId] = false;
    setRunControlLoading(true);
    try {
      const run = await api.pauseRun(target.runId);
      syncRunIntoChat(activeChatId, run);
      showStatus('已暂停任务');
    } catch (e: any) {
      showStatus(`暂停失败: ${e.message}`);
    } finally {
      setRunControlLoading(false);
    }
  }, [activeChatId, chats, showStatus, syncRunIntoChat]);

  const resumeActiveRun = useCallback(async () => {
    const target = chats.find(c => c.id === activeChatId);
    if (!target?.runId) {
      showStatus('当前没有可继续的任务');
      return;
    }
    setRunControlLoading(true);
    try {
      const run = await api.resumeRun(target.runId);
      syncRunIntoChat(activeChatId, run);
      void startAutoRun(activeChatId, target.runId);
      showStatus('已继续任务');
    } catch (e: any) {
      showStatus(`恢复失败: ${e.message}`);
    } finally {
      setRunControlLoading(false);
    }
  }, [activeChatId, chats, showStatus, startAutoRun, syncRunIntoChat]);

  const cancelActiveRun = useCallback(async () => {
    const target = chats.find(c => c.id === activeChatId);
    if (!target?.runId) {
      showStatus('当前没有可取消的任务');
      return;
    }
    runDriversRef.current[target.runId] = false;
    setRunControlLoading(true);
    try {
      const run = await api.cancelRun(target.runId);
      syncRunIntoChat(activeChatId, run);
      showStatus('已取消任务');
    } catch (e: any) {
      showStatus(`取消失败: ${e.message}`);
    } finally {
      setRunControlLoading(false);
    }
  }, [activeChatId, chats, showStatus, syncRunIntoChat]);

  const submitAskUserInput = useCallback(async (message: string) => {
    const target = chats.find(c => c.id === activeChatId);
    if (!target?.runId) {
      showStatus('当前没有可继续的流程');
      return;
    }
    const text = (message || '').trim();
    if (!text) {
      showStatus('请输入补充信息');
      return;
    }
    setRunControlLoading(true);
    try {
      const result = await api.replyRun(target.runId, text);
      setChats(prev => prev.map(chat =>
        chat.id === activeChatId
          ? {
            ...chat,
            lastAIResult: result,
            executionEvents: mergeExecutionEvents(chat.executionEvents, result.run?.events || []),
            runId: result.run_id || result.run?.run_id || chat.runId,
            needsUserTrigger: result.needs_user_trigger === true,
            pendingActions: result.pending_actions || [],
            runStatus: result.run?.status || chat.runStatus,
          }
          : chat
      ));
      const runId = result.run_id || result.run?.run_id;
      if (runId) {
        void startAutoRun(activeChatId, runId);
      }
    } catch (e: any) {
      showStatus(`提交补充信息失败: ${e.message}`);
      throw e;
    } finally {
      setRunControlLoading(false);
    }
  }, [activeChatId, chats, showStatus, startAutoRun]);

  const handleDiffApply = useCallback(async () => {
    if (!diffData) return;
    await applyFile(diffData.path, diffData.newContent);
    setShowDiff(false);
    setDiffData(null);
    showStatus(`已应用修改: ${diffData.path}`);
  }, [diffData, applyFile, showStatus]);

  const handleDiffCancel = useCallback(() => {
    setShowDiff(false);
    setDiffData(null);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-editor-bg text-text-primary overflow-hidden">
      {/* Top Bar */}
      <div className="flex items-center justify-between h-10 px-3 bg-[#323233] border-b border-border-color select-none">
        <div className="flex items-center gap-2">
          <Bot size={18} className="text-accent" />
          <span className="text-sm font-semibold tracking-wide">Nexar Code</span>
          <span className="text-[10px] px-1.5 py-0.5 bg-accent/20 text-accent rounded font-mono">VIP</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSidebar(!showSidebar)}
            className="p-1.5 hover:bg-hover-bg rounded"
            title={showSidebar ? '隐藏侧栏' : '显示侧栏'}
          >
            {showSidebar ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          <button
            onClick={() => setShowChat(!showChat)}
            className="p-1.5 hover:bg-hover-bg rounded"
            title={showChat ? '隐藏AI面板' : '显示AI面板'}
          >
            {showChat ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
        </div>
      </div>

      {/* Main Area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar */}
          {showSidebar && (
            <div style={{ width: sidebarWidth }} className="flex-shrink-0 border-r border-border-color overflow-hidden">
              <FileTree
                files={files}
                activeFile={activeFile}
                onFileSelect={openFile}
                onRefresh={loadFileTree}
                onCreate={createItem}
                onDelete={deleteItem}
                onRename={renameItem}
              />
            </div>
          )}
          {showSidebar && (
            <div
              className="w-1 flex-shrink-0 cursor-col-resize bg-transparent hover:bg-accent/30 active:bg-accent/40"
              onMouseDown={e => setResizing({ panel: 'sidebar', startX: e.clientX, startWidth: sidebarWidth })}
              title="拖动调整目录树宽度"
            />
          )}

          {/* Editor Area */}
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="flex-1 overflow-hidden">
              {showDiff && diffData ? (
                <DiffView
                  filePath={diffData.path}
                  oldContent={diffData.oldContent}
                  newContent={diffData.newContent}
                  language={diffData.language}
                  onApply={handleDiffApply}
                  onCancel={handleDiffCancel}
                />
              ) : (
                <CodeEditor
                  openFiles={openFiles}
                  activeFile={activeFile}
                  onTabSelect={setActiveFile}
                  onTabClose={closeFile}
                  onContentChange={updateContent}
                  onSave={saveFile}
                  onAddSnippetToCurrentChat={addSnippetToCurrentChat}
                  onAddSnippetToNewChat={addSnippetToNewChat}
                />
              )}
            </div>

            {showTerminal && (
              <div
                className="h-1 cursor-row-resize bg-transparent hover:bg-accent/40 active:bg-accent/60"
                onMouseDown={e => setTerminalResizing({ startY: e.clientY, startHeight: terminalHeight })}
                title="拖动调整控制台高度"
              />
            )}

            {showTerminal && (
              <div style={{ height: terminalHeight }} className="border-t border-border-color">
                <TerminalPanel onStatus={msg => showStatus(msg)} />
              </div>
            )}
          </div>

          {/* Chat Panel */}
          {showChat && (
            <>
              <div
                className="w-1 flex-shrink-0 cursor-col-resize bg-transparent hover:bg-accent/30 active:bg-accent/40"
                onMouseDown={e => setResizing({ panel: 'chat', startX: e.clientX, startWidth: chatWidth })}
                title="拖动调整聊天面板宽度"
              />
              <div style={{ width: chatWidth }} className="flex-shrink-0 border-l border-border-color overflow-hidden">
                <ChatPanel
                  chatTabs={chats.map(c => ({ id: c.id, title: c.title }))}
                  activeChatId={activeChatId}
                  onChatSelect={setActiveChatId}
                  onChatCreate={createChatTab}
                  onChatClose={closeChatTab}
                  draftSnippets={activeChat?.draftSnippets || []}
                  onDraftSnippetsChange={setActiveChatDraftSnippets}
                  messages={activeChat?.messages || []}
                  loading={aiLoading}
                  providers={providers}
                  currentProvider={currentProvider}
                  onProviderChange={setCurrentProvider}
                  onSend={sendMessage}
                  onClear={clearActiveChat}
                  activeFile={activeFile}
                  lastAIResult={activeChat?.lastAIResult || null}
                  executionEvents={activeChat?.executionEvents || []}
                  onApplyFile={applyFile}
                  onShowDiff={showDiffView}
                  getCurrentFileContent={getCurrentFileContent}
                  pendingActions={activeChat?.pendingActions || []}
                  runStatus={activeChat?.runStatus}
                  controlDisabled={runControlLoading}
                  onPauseRun={pauseActiveRun}
                  onResumeRun={resumeActiveRun}
                  onCancelRun={cancelActiveRun}
                  onSubmitAskUserInput={submitAskUserInput}
                />
              </div>
            </>
          )}
        </div>

      </div>

      {/* Status Bar */}
      <div className="flex items-center justify-between h-6 px-2 bg-[#0f1115] border-t border-border-color text-[#c6cbd3] text-[11px] select-none">
        <div className="flex items-center gap-1.5">
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[#1a1f2a]">
            <Terminal size={11} />
            Nexar Code VIP
          </span>
          <button
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded border ${
              showTerminal
                ? 'bg-[#1a2433] border-[#2c7be5]/40 text-[#7db3ff]'
                : 'bg-transparent border-transparent hover:border-border-color hover:bg-[#1a1f2a]'
            }`}
            onClick={() => setShowTerminal(v => !v)}
            title={showTerminal ? '隐藏控制台' : '显示控制台'}
          >
            <Terminal size={10} />
            <span>Terminal</span>
          </button>
          {activeFile && <span>{activeFile}</span>}
        </div>
        <div className="flex items-center gap-2.5">
          {statusMsg && <span className="animate-pulse">{statusMsg}</span>}
          <span>UTF-8</span>
          {activeFile && (
            <span>{openFiles.find(f => f.path === activeFile)?.language || 'plaintext'}</span>
          )}
          <button
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-transparent hover:border-border-color hover:bg-[#1a1f2a]"
            onClick={() => setShowSettingsPage(true)}
            title="打开设置"
          >
            <Settings size={10} />
            <span>设置</span>
          </button>
        </div>
      </div>
      {showSettingsPage && (
        <SettingsPage
          onClose={() => setShowSettingsPage(false)}
          historyConfig={historyConfig}
          onHistoryConfigChange={updateHistoryConfig}
        />
      )}
    </div>
  );
}
