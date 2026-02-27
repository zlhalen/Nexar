import React, { useRef, useCallback } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { X, Save, FileCode } from 'lucide-react';
import type { CodeSnippet } from '../api';

interface OpenFile {
  path: string;
  content: string;
  language: string;
  modified: boolean;
}

interface Props {
  openFiles: OpenFile[];
  activeFile: string | null;
  onTabSelect: (path: string) => void;
  onTabClose: (path: string) => void;
  onContentChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
  onAddSnippetToCurrentChat?: (snippet: CodeSnippet) => void;
  onAddSnippetToNewChat?: (snippet: CodeSnippet) => void;
}

function getTabLabel(path: string) {
  return path.split('/').pop() || path;
}

export default function CodeEditor({
  openFiles, activeFile, onTabSelect, onTabClose, onContentChange, onSave,
  onAddSnippetToCurrentChat, onAddSnippetToNewChat,
}: Props) {
  const editorRef = useRef<any>(null);
  const [contextMenu, setContextMenu] = React.useState<{
    x: number;
    y: number;
    snippet: CodeSnippet | null;
  } | null>(null);

  const getSelectedSnippet = (editor: any): CodeSnippet | null => {
    if (!activeFile) return null;
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection || selection.isEmpty()) return null;
    const selectedText = model.getValueInRange(selection);
    if (!selectedText) return null;
    return {
      file_path: activeFile,
      start_line: selection.startLineNumber,
      end_line: selection.endLineNumber,
      content: selectedText,
    };
  };

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.addCommand(2097 /* KeyMod.CtrlCmd | KeyCode.KeyS */, () => {
      if (activeFile) onSave(activeFile);
    });

    const domNode = editor.getDomNode();
    if (!domNode) return;

    const onCopy = (event: ClipboardEvent) => {
      const snippet = getSelectedSnippet(editor);
      if (!snippet) return;

      event.clipboardData?.setData('text/plain', snippet.content);
      event.clipboardData?.setData('application/x-nexar-snippet', JSON.stringify(snippet));
      event.preventDefault();
    };

    const onContextMenu = (event: MouseEvent) => {
      const snippet = getSelectedSnippet(editor);
      event.preventDefault();
      event.stopPropagation();
      const menuWidth = 260;
      const menuHeight = 220;
      const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8));
      const y = Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8));
      setContextMenu({ x, y, snippet });
    };

    const onMouseDown = () => setContextMenu(null);

    domNode.addEventListener('copy', onCopy);
    domNode.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('mousedown', onMouseDown);
    editor.onDidDispose(() => {
      domNode.removeEventListener('copy', onCopy);
      domNode.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('mousedown', onMouseDown);
    });
  };

  const currentFile = openFiles.find(f => f.path === activeFile);

  const handleCut = async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const snippet = getSelectedSnippet(editor);
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet.content);
    } catch {
      // Ignore clipboard write errors; still attempt editor edit.
    }
    editor.executeEdits('nexar-cut', [{ range: editor.getSelection(), text: '' }]);
    setContextMenu(null);
  };

  const handleCopy = async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const snippet = getSelectedSnippet(editor);
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet.content);
    } catch {
      // Ignore clipboard write errors.
    }
    setContextMenu(null);
  };

  const handlePaste = async () => {
    const editor = editorRef.current;
    if (!editor) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      editor.executeEdits('nexar-paste', [{ range: editor.getSelection(), text }]);
    } catch {
      // Ignore clipboard read errors.
    } finally {
      setContextMenu(null);
    }
  };

  const handleCommandPalette = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.trigger('nexar-context-menu', 'editor.action.quickCommand', null);
    setContextMenu(null);
  };

  const handleChange = useCallback((value: string | undefined) => {
    if (activeFile && value !== undefined) {
      onContentChange(activeFile, value);
    }
  }, [activeFile, onContentChange]);

  if (openFiles.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-editor-bg text-text-secondary">
        <FileCode size={64} className="mb-4 opacity-30" />
        <h2 className="text-xl font-light mb-2">Nexar Code</h2>
        <p className="text-sm">选择文件开始编辑，或使用 AI 助手生成代码</p>
        <div className="mt-6 text-xs space-y-1 text-center opacity-60">
          <p>Ctrl+S 保存文件</p>
          <p>在右侧面板与 AI 对话</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-editor-bg">
      {/* Tabs */}
      <div className="flex items-center bg-sidebar-bg border-b border-border-color overflow-x-auto">
        {openFiles.map(file => (
          <div
            key={file.path}
            className={`flex items-center gap-1.5 px-3 py-1.5 cursor-pointer border-r border-border-color min-w-0 group
              ${file.path === activeFile ? 'bg-editor-bg text-text-primary' : 'text-text-secondary hover:bg-hover-bg'}`}
            onClick={() => onTabSelect(file.path)}
          >
            <span className="text-sm truncate max-w-[120px]">
              {file.modified && <span className="text-accent mr-0.5">●</span>}
              {getTabLabel(file.path)}
            </span>
            <button
              className="p-0.5 rounded hover:bg-active-bg opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={e => { e.stopPropagation(); onTabClose(file.path); }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      {/* Breadcrumb */}
      {currentFile && (
        <div className="flex items-center gap-2 px-3 py-1 bg-sidebar-bg border-b border-border-color text-xs text-text-secondary">
          <span>{currentFile.path}</span>
          <span className="ml-auto text-text-secondary">{currentFile.language}</span>
          {currentFile.modified && (
            <button
              className="flex items-center gap-1 px-2 py-0.5 bg-accent text-white rounded text-xs hover:bg-accent-hover"
              onClick={() => onSave(currentFile.path)}
            >
              <Save size={10} /> 保存
            </button>
          )}
        </div>
      )}

      {/* Editor */}
      <div className="flex-1">
        {currentFile && (
          <Editor
            key={currentFile.path}
            language={currentFile.language || 'plaintext'}
            value={currentFile.content}
            theme="vs-dark"
            onChange={handleChange}
            onMount={handleMount}
            options={{
              fontSize: 14,
              lineHeight: 22,
              minimap: { enabled: true },
              contextmenu: false,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              formatOnPaste: true,
              formatOnType: true,
              tabSize: 2,
              renderLineHighlight: 'all',
              bracketPairColorization: { enabled: true },
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              smoothScrolling: true,
              padding: { top: 8, bottom: 8 },
            }}
          />
        )}
      </div>
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[260px] rounded border border-border-color bg-sidebar-bg shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button
            className="w-full px-3 py-2 text-left text-sm hover:bg-hover-bg disabled:text-text-secondary/50 disabled:hover:bg-transparent"
            onClick={() => {
              if (!contextMenu.snippet) return;
              onAddSnippetToNewChat?.(contextMenu.snippet);
              setContextMenu(null);
            }}
            disabled={!contextMenu.snippet}
          >
            Add Snippet to New Chat
          </button>
          <button
            className="w-full px-3 py-2 text-left text-sm hover:bg-hover-bg disabled:text-text-secondary/50 disabled:hover:bg-transparent"
            onClick={() => {
              if (!contextMenu.snippet) return;
              onAddSnippetToCurrentChat?.(contextMenu.snippet);
              setContextMenu(null);
            }}
            disabled={!contextMenu.snippet}
          >
            Add Snippet to Current Chat
          </button>
          <div className="border-t border-border-color" />
          <button
            className="w-full px-3 py-2 text-left text-sm hover:bg-hover-bg"
            onClick={handleCut}
            disabled={!contextMenu.snippet}
          >
            Cut
          </button>
          <button
            className="w-full px-3 py-2 text-left text-sm hover:bg-hover-bg disabled:text-text-secondary/50 disabled:hover:bg-transparent"
            onClick={handleCopy}
            disabled={!contextMenu.snippet}
          >
            Copy
          </button>
          <button
            className="w-full px-3 py-2 text-left text-sm hover:bg-hover-bg"
            onClick={handlePaste}
          >
            Paste
          </button>
          <div className="border-t border-border-color" />
          <button
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-hover-bg"
            onClick={handleCommandPalette}
          >
            <span>Command Palette</span>
            <span className="text-text-secondary">F1</span>
          </button>
        </div>
      )}
    </div>
  );
}
