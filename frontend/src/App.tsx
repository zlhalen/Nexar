import React, { useState, useEffect, useCallback } from 'react';
import {
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Terminal, Bot,
} from 'lucide-react';
import FileTree from './components/FileTree';
import CodeEditor from './components/CodeEditor';
import ChatPanel from './components/ChatPanel';
import DiffView from './components/DiffView';
import TerminalPanel from './components/TerminalPanel';
import { api } from './api';
import type {
  FileItem, ChatMessage, AIResponse, Provider, CodeSnippet, PlanBlock, FileChange, PlanRunInfo,
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
  planningMode?: boolean;
}

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  lastAIResult: AIResponse | null;
  draftSnippets: CodeSnippet[];
  activePlan: PlanBlock | null;
  planRunning: boolean;
}

function createChatSession(index: number): ChatSession {
  return {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: `Chat ${index}`,
    messages: [],
    lastAIResult: null,
    draftSnippets: [],
    activePlan: null,
    planRunning: false,
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

export default function App() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showChat, setShowChat] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(256);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [chatWidth, setChatWidth] = useState(380);
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
  const [providers, setProviders] = useState<Provider[]>([]);
  const [currentProvider, setCurrentProvider] = useState('openai');
  const [statusMsg, setStatusMsg] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [diffData, setDiffData] = useState<{
    path: string;
    oldContent: string;
    newContent: string;
    language: string;
  } | null>(null);

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

  const closeFile = useCallback((path: string) => {
    const file = openFiles.find(f => f.path === path);
    if (file?.modified && !confirm(`${path} 有未保存的修改，确定关闭？`)) return;
    setOpenFiles(prev => prev.filter(f => f.path !== path));
    if (activeFile === path) {
      const remaining = openFiles.filter(f => f.path !== path);
      setActiveFile(remaining.length > 0 ? remaining[remaining.length - 1].path : null);
    }
  }, [openFiles, activeFile]);

  const updateContent = useCallback((path: string, content: string) => {
    setOpenFiles(prev => prev.map(f =>
      f.path === path ? { ...f, content, modified: true } : f
    ));
  }, []);

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
        ? { ...chat, messages: [], lastAIResult: null, draftSnippets: [], activePlan: null, planRunning: false }
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

  const sendMessage = useCallback(async (text: string, options?: SendOptions) => {
    if (!activeChatId) return;
    const targetChat = chats.find(c => c.id === activeChatId);
    if (!targetChat) return;

    const userMsg: ChatMessage = {
      role: 'user',
      content: text,
      snippets: options?.snippets && options.snippets.length > 0 ? options.snippets : undefined,
      chat_only: options?.chatOnly === true,
      planning_mode: options?.planningMode === true,
    };
    const newMessages = [...targetChat.messages, userMsg];
    setChats(prev => prev.map(chat =>
      chat.id === activeChatId
        ? { ...chat, messages: newMessages }
        : chat
    ));
    setAiLoading(true);
    setChats(prev => prev.map(chat =>
      chat.id === activeChatId
        ? { ...chat, lastAIResult: null }
        : chat
    ));

    const currentFileObj = openFiles.find(f => f.path === activeFile);

    try {
      const result = await api.chat({
        provider: currentProvider,
        messages: newMessages,
        current_file: activeFile || undefined,
        current_code: currentFileObj?.content,
        snippets: options?.snippets,
        chat_only: options?.chatOnly === true,
        planning_mode: options?.planningMode === true,
      });

      const assistantMsg: ChatMessage = { role: 'assistant', content: result.content };
      setChats(prev => prev.map(chat =>
        chat.id === activeChatId
          ? {
              ...chat,
              messages: [...chat.messages, assistantMsg],
              lastAIResult: result,
              draftSnippets: [],
              activePlan: result.action === 'plan' && result.plan
                ? {
                    ...result.plan,
                    steps: result.plan.steps.map(step => ({
                      ...step,
                      status: step.status || 'pending',
                      summary: '',
                      error: '',
                      changes: [],
                    })),
                  }
                : chat.activePlan,
            }
          : chat
      ));

      if (result.file_path && result.file_content && !options?.planningMode) {
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
    } catch (e: any) {
      const errMsg: ChatMessage = { role: 'assistant', content: `❌ 错误: ${e.message}` };
      setChats(prev => prev.map(chat =>
        chat.id === activeChatId
          ? { ...chat, messages: [...chat.messages, errMsg] }
          : chat
      ));
    } finally {
      setAiLoading(false);
    }
  }, [activeChatId, chats, currentProvider, activeFile, openFiles, loadFileTree, showStatus]);

  const executePlan = useCallback(async () => {
    if (!activeChatId || aiLoading) return;
    const targetChat = chats.find(c => c.id === activeChatId);
    const plan = targetChat?.activePlan;
    if (!plan || plan.steps.length === 0) return;

    const normalizedPlan: PlanBlock = {
      ...plan,
      steps: plan.steps.map(step => ({
        ...step,
        status: step.status === 'in_progress' ? 'pending' : (step.status || 'pending'),
      })),
    };

    let workingPlan = normalizedPlan;
    const currentFileObj = openFiles.find(f => f.path === activeFile);

    setChats(prev => prev.map(chat =>
      chat.id === activeChatId
        ? { ...chat, planRunning: true, activePlan: normalizedPlan, lastAIResult: null }
        : chat
    ));

    try {
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      const pollRun = async (runId: string, onTick?: (run: PlanRunInfo) => void): Promise<PlanRunInfo | null> => {
        let latest: PlanRunInfo | null = null;
        for (let k = 0; k < 240; k++) {
          try {
            latest = await api.getRun(runId);
            if (latest && onTick) onTick(latest);
            if (latest.status === 'completed' || latest.status === 'failed') {
              return latest;
            }
          } catch {
            // Best-effort polling; fallback to response.run if unavailable.
            return latest;
          }
          await sleep(250);
        }
        return latest;
      };

      for (let i = 0; i < workingPlan.steps.length; i++) {
        const step = workingPlan.steps[i];
        if (step.status === 'completed') continue;

        const inProgressPlan: PlanBlock = {
          ...workingPlan,
          steps: workingPlan.steps.map((s, idx) =>
            idx === i ? { ...s, status: 'in_progress' } : s
          ),
        };
        workingPlan = inProgressPlan;
        setChats(prev => prev.map(chat =>
          chat.id === activeChatId
            ? { ...chat, activePlan: inProgressPlan }
            : chat
        ));

        const execPrompt =
          `按已确认计划执行第 ${i + 1} 步，仅执行这一步，不要提前执行后续步骤。\n` +
          `目标：${workingPlan.summary}\n` +
          `当前步骤：${step.title}\n` +
          `步骤说明：${step.detail || '无'}\n` +
          `验收标准：${step.acceptance || '无'}\n` +
          `执行后仅返回简短完成说明。`;

        const runStart = await api.startRun({
          provider: currentProvider,
          messages: [
            ...targetChat!.messages,
            { role: 'user', content: execPrompt },
          ],
          current_file: activeFile || undefined,
          current_code: currentFileObj?.content,
          chat_only: false,
          planning_mode: false,
          force_code_edit: true,
        });
        const runInfo = await pollRun(runStart.run_id, (tick) => {
          const tickStep = tick.steps?.[tick.current_step_index >= 0 ? tick.current_step_index : Math.max(0, tick.steps.length - 1)];
          setChats(prev => prev.map(chat => {
            if (chat.id !== activeChatId || !chat.activePlan) return chat;
            const steps = chat.activePlan.steps.map((s, idx) =>
              idx === i
                ? {
                    ...s,
                    status: tickStep?.status || s.status,
                    backend_run_id: tick.run_id,
                    backend_step_status: tickStep?.status || '',
                    backend_attempts: tickStep?.attempts ?? s.backend_attempts ?? 0,
                    error: tickStep?.error || s.error,
                  }
                : s
            );
            return { ...chat, activePlan: { ...chat.activePlan, steps } };
          }));
        });
        if (!runInfo) {
          throw new Error(`run ${runStart.run_id} 轮询失败`);
        }
        const backendStep = runInfo.steps?.[runInfo.current_step_index >= 0 ? runInfo.current_step_index : Math.max(0, runInfo.steps.length - 1)];

        if (runInfo.result_file_path && runInfo.result_file_content) {
          await loadFileTree();
        }

        const stepChanges: FileChange[] = runInfo.result_changes && runInfo.result_changes.length > 0
          ? runInfo.result_changes
          : (runInfo.result_file_path && runInfo.result_file_content
            ? [{
                file_path: runInfo.result_file_path,
                file_content: runInfo.result_file_content,
                before_content: '',
                after_content: runInfo.result_file_content,
                diff_unified: '',
                before_hash: '',
                after_hash: '',
                write_result: 'written',
              }]
            : []);

        const hasWritten = stepChanges.some(change => change.write_result === 'written');
        const hasFailed = stepChanges.some(change => change.write_result === 'failed');
        const localStatus = hasFailed ? (hasWritten ? 'partial' : 'failed') : 'completed';
        const finalStatus = backendStep?.status || localStatus;

        const completedPlan: PlanBlock = {
          ...workingPlan,
          steps: workingPlan.steps.map((s, idx) =>
            idx === i
              ? {
                  ...s,
                  status: finalStatus,
                  summary: runInfo.result_content || '',
                  error: backendStep?.error || (hasFailed ? stepChanges.filter(c => c.error).map(c => c.error).join('; ') : ''),
                  changes: stepChanges,
                  backend_run_id: runInfo?.run_id || '',
                  backend_step_status: backendStep?.status || '',
                  backend_attempts: backendStep?.attempts ?? 0,
                }
              : s
          ),
        };
        workingPlan = completedPlan;
        setChats(prev => prev.map(chat =>
          chat.id === activeChatId
            ? { ...chat, activePlan: completedPlan }
            : chat
        ));

        if (!hasWritten) {
          throw new Error(`步骤 ${i + 1} 执行失败，未产生可写入变更`);
        }
      }
      showStatus('计划执行完成');
    } catch (e: any) {
      const failedIndex = workingPlan.steps.findIndex(step => step.status === 'in_progress');
      const failedPlan: PlanBlock = failedIndex === -1
        ? workingPlan
        : {
            ...workingPlan,
            steps: workingPlan.steps.map((s, idx) =>
              idx === failedIndex ? { ...s, status: 'failed' } : s
            ),
          };
      setChats(prev => prev.map(chat =>
        chat.id === activeChatId
          ? { ...chat, activePlan: failedPlan }
          : chat
      ));
      showStatus(`计划执行中断: ${e.message}`);
    } finally {
      setChats(prev => prev.map(chat =>
        chat.id === activeChatId
          ? { ...chat, planRunning: false }
          : chat
      ));
    }
  }, [activeChatId, aiLoading, chats, openFiles, activeFile, currentProvider, loadFileTree, showStatus]);

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
                  activePlan={activeChat?.activePlan || null}
                  planRunning={activeChat?.planRunning || false}
                  onApplyFile={applyFile}
                  onShowDiff={showDiffView}
                  getCurrentFileContent={getCurrentFileContent}
                  onExecutePlan={executePlan}
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
        </div>
      </div>
    </div>
  );
}
