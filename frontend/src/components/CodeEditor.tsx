import React, { useRef, useCallback } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { X, Save, FileCode } from 'lucide-react';

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
}

function getTabLabel(path: string) {
  return path.split('/').pop() || path;
}

export default function CodeEditor({ openFiles, activeFile, onTabSelect, onTabClose, onContentChange, onSave }: Props) {
  const editorRef = useRef<any>(null);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.addCommand(2097 /* KeyMod.CtrlCmd | KeyCode.KeyS */, () => {
      if (activeFile) onSave(activeFile);
    });
  };

  const currentFile = openFiles.find(f => f.path === activeFile);

  const handleChange = useCallback((value: string | undefined) => {
    if (activeFile && value !== undefined) {
      onContentChange(activeFile, value);
    }
  }, [activeFile, onContentChange]);

  if (openFiles.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-editor-bg text-text-secondary">
        <FileCode size={64} className="mb-4 opacity-30" />
        <h2 className="text-xl font-light mb-2">AI CodeGen</h2>
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
    </div>
  );
}
