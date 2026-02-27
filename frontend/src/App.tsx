import React, { useState, useEffect, useCallback } from 'react';
import {
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Terminal, Bot,
} from 'lucide-react';
import FileTree from './components/FileTree';
import CodeEditor from './components/CodeEditor';
import ChatPanel from './components/ChatPanel';
import { api } from './api';
import type { FileItem, ChatMessage, AIResponse, Provider } from './api';

interface OpenFile {
  path: string;
  content: string;
  language: string;
  modified: boolean;
}

export default function App() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showChat, setShowChat] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [currentProvider, setCurrentProvider] = useState('openai');
  const [lastAIResult, setLastAIResult] = useState<AIResponse | null>(null);
  const [statusMsg, setStatusMsg] = useState('');

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

  const sendMessage = useCallback(async (text: string, action: string, filePath?: string) => {
    const userMsg: ChatMessage = { role: 'user', content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setAiLoading(true);
    setLastAIResult(null);

    const currentFileObj = openFiles.find(f => f.path === activeFile);

    try {
      const result = await api.chat({
        provider: currentProvider,
        messages: newMessages,
        current_file: activeFile || undefined,
        current_code: currentFileObj?.content,
        action,
        file_path: filePath,
      });

      const assistantMsg: ChatMessage = { role: 'assistant', content: result.content };
      setMessages(prev => [...prev, assistantMsg]);
      setLastAIResult(result);

      if (result.file_path && result.file_content) {
        await loadFileTree();
        showStatus(`AI ${result.action === 'generate' ? '生成' : '修改'}了文件: ${result.file_path}`);
      }
    } catch (e: any) {
      const errMsg: ChatMessage = { role: 'assistant', content: `❌ 错误: ${e.message}` };
      setMessages(prev => [...prev, errMsg]);
    } finally {
      setAiLoading(false);
    }
  }, [messages, currentProvider, activeFile, openFiles, loadFileTree, showStatus]);

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

  return (
    <div className="h-screen flex flex-col bg-editor-bg text-text-primary overflow-hidden">
      {/* Top Bar */}
      <div className="flex items-center justify-between h-10 px-3 bg-[#323233] border-b border-border-color select-none">
        <div className="flex items-center gap-2">
          <Bot size={18} className="text-accent" />
          <span className="text-sm font-semibold tracking-wide">AI CodeGen</span>
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
          <div className="w-60 flex-shrink-0 border-r border-border-color overflow-hidden">
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

        {/* Editor */}
        <div className="flex-1 overflow-hidden">
          <CodeEditor
            openFiles={openFiles}
            activeFile={activeFile}
            onTabSelect={setActiveFile}
            onTabClose={closeFile}
            onContentChange={updateContent}
            onSave={saveFile}
          />
        </div>

        {/* Chat Panel */}
        {showChat && (
          <div className="w-[380px] flex-shrink-0 border-l border-border-color overflow-hidden">
            <ChatPanel
              messages={messages}
              loading={aiLoading}
              providers={providers}
              currentProvider={currentProvider}
              onProviderChange={setCurrentProvider}
              onSend={sendMessage}
              onClear={() => { setMessages([]); setLastAIResult(null); }}
              activeFile={activeFile}
              lastAIResult={lastAIResult}
              onApplyFile={applyFile}
            />
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="flex items-center justify-between h-6 px-3 bg-accent text-white text-[11px] select-none">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <Terminal size={11} />
            AI CodeGen VIP
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
