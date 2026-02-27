import React, { useMemo } from 'react';
import { X, Check, XCircle } from 'lucide-react';
import Editor, { DiffEditor, OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

interface DiffViewProps {
  filePath: string;
  oldContent: string;
  newContent: string;
  language?: string;
  onApply: () => void;
  onCancel: () => void;
}

export default function DiffView({
  filePath,
  oldContent,
  newContent,
  language = 'plaintext',
  onApply,
  onCancel,
}: DiffViewProps) {
  const diffEditorRef = React.useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  const handleEditorMount: OnMount = (editor) => {
    diffEditorRef.current = editor as monaco.editor.IStandaloneDiffEditor;
    
    // 配置编辑器选项
    const modifiedEditor = editor.getModifiedEditor();
    const originalEditor = editor.getOriginalEditor();
    
    // 禁用编辑功能（只读模式）
    modifiedEditor.updateOptions({ readOnly: true });
    originalEditor.updateOptions({ readOnly: true });
    
    // 配置主题和样式
    monaco.editor.defineTheme('diff-theme', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'diffEditor.insertedTextBackground': '#1e4a1e40',
        'diffEditor.removedTextBackground': '#4a1e1e40',
        'diffEditor.insertedLineBackground': '#1e4a1e20',
        'diffEditor.removedLineBackground': '#4a1e1e20',
      },
    });
    monaco.editor.setTheme('diff-theme');
  };

  // 计算统计信息
  const stats = useMemo(() => {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const maxLines = Math.max(oldLines.length, newLines.length);
    let added = 0;
    let removed = 0;
    let unchanged = 0;

    // 简单的行比较
    const minLines = Math.min(oldLines.length, newLines.length);
    for (let i = 0; i < minLines; i++) {
      if (oldLines[i] === newLines[i]) {
        unchanged++;
      } else {
        removed++;
        added++;
      }
    }
    if (oldLines.length > newLines.length) {
      removed += oldLines.length - newLines.length;
    } else if (newLines.length > oldLines.length) {
      added += newLines.length - oldLines.length;
    }

    return { added, removed, unchanged, total: maxLines };
  }, [oldContent, newContent]);

  return (
    <div className="h-full flex flex-col bg-editor-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-sidebar-bg border-b border-border-color">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-text-primary">代码对比</span>
          <span className="text-xs text-text-secondary truncate max-w-md">{filePath}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onApply}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-success text-white rounded text-xs hover:bg-success/90 transition-colors"
          >
            <Check size={14} /> 应用修改
          </button>
          <button
            onClick={onCancel}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-active-bg text-text-primary rounded text-xs hover:bg-hover-bg transition-colors"
          >
            <XCircle size={14} /> 取消
          </button>
          <button
            onClick={onCancel}
            className="p-1.5 hover:bg-hover-bg rounded transition-colors"
            title="关闭"
          >
            <X size={16} className="text-text-secondary" />
          </button>
        </div>
      </div>

      {/* Diff Editor */}
      <div className="flex-1 overflow-hidden">
        <DiffEditor
          height="100%"
          language={language}
          original={oldContent}
          modified={newContent}
          onMount={handleEditorMount}
          options={{
            readOnly: true,
            renderSideBySide: true,
            enableSplitViewResizing: true,
            fontSize: 13,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            diffWordWrap: 'on',
            renderIndicators: true,
            originalEditable: false,
            modifiedEditable: false,
            diffCodeLens: false,
            renderOverviewRuler: true,
            overviewRulerLanes: 2,
            overviewRulerBorder: false,
            hideUnchangedRegions: {
              enabled: false,
            },
          }}
          theme="vs-dark"
        />
      </div>

      {/* Footer Stats */}
      <div className="px-4 py-1.5 bg-sidebar-bg border-t border-border-color text-xs text-text-secondary">
        <div className="flex items-center gap-4">
          <span>
            删除: <span className="text-[#ff6b6b]">{stats.removed}</span> 行
          </span>
          <span>
            新增: <span className="text-[#6bff6b]">{stats.added}</span> 行
          </span>
          <span>
            未变更: <span className="text-text-primary">{stats.unchanged}</span> 行
          </span>
          <span className="ml-auto">
            总计: <span className="text-text-primary">{stats.total}</span> 行
          </span>
        </div>
      </div>
    </div>
  );
}
