import React, { useState, useEffect, useCallback } from 'react';
import {
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Terminal, Bot,
} from 'lucide-react';
import FileTree from './components/FileTree';
import CodeEditor from './components/CodeEditor';
import ChatPanel from './components/ChatPanel';
import DiffView from './components/DiffView';
import { api } from './api';
import type { FileItem, ChatMessage, AIResponse, Provider, CodeSnippet } from './api';

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
  draftSnippets: CodeSnippet[];
}

function createChatSession(index: number): ChatSession {
  return {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: `Chat ${index}`,
    messages: [],
    lastAIResult: null,
    draftSnippets: [],
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
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [chatWidth, setChatWidth] = useState(380);
  const [resizing, setResizing] = useState<{
    panel: 'sidebar' | 'chat';
    startX: number;
    startWidth: number;
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
        ? { ...chat, messages: [], lastAIResult: null, draftSnippets: [] }
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
      });

      const assistantMsg: ChatMessage = { role: 'assistant', content: result.content };
      setChats(prev => prev.map(chat =>
        chat.id === activeChatId
          ? {
              ...chat,
              messages: [...chat.messages, assistantMsg],
              lastAIResult: result,
              draftSnippets: [],
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

        {/* Editor or Diff View */}
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
                onApplyFile={applyFile}
                onShowDiff={showDiffView}
                getCurrentFileContent={getCurrentFileContent}
              />
            </div>
          </>
        )}
      </div>

      {/* Status Bar */}
      <div className="flex items-center justify-between h-6 px-3 bg-accent text-white text-[11px] select-none">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <Terminal size={11} />
            Nexar Code VIP
          </span>
          {activeFile && <span>{activeFile}</span>}
        </div>
        <div className="flex items-center gap-3">
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
