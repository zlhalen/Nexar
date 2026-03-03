import React, { useState } from 'react';
import {
  ChevronRight, ChevronDown, File, Folder, FolderOpen,
  Plus, FolderPlus, Trash2, Pencil, RefreshCw,
} from 'lucide-react';
import type { FileItem } from '../api';

interface Props {
  files: FileItem[];
  activeFile: string | null;
  workspaceRoot?: string;
  onFileSelect: (path: string) => void;
  onRefresh: () => void;
  onSwitchWorkspace: (path: string) => void;
  onCreate: (path: string, isDir: boolean) => void;
  onDelete: (path: string) => void;
  onRename: (oldPath: string, newPath: string) => void;
}

const FILE_ICONS: Record<string, string> = {
  py: '🐍', js: '📜', ts: '💠', tsx: '⚛️', jsx: '⚛️',
  html: '🌐', css: '🎨', json: '📋', md: '📝',
  go: '🔵', rs: '🦀', java: '☕', rb: '💎',
};

function getIcon(name: string, isDir: boolean, isOpen: boolean) {
  if (isDir) {
    return isOpen
      ? <FolderOpen size={16} className="text-yellow-500 flex-shrink-0" />
      : <Folder size={16} className="text-yellow-500 flex-shrink-0" />;
  }
  const ext = name.split('.').pop() || '';
  const emoji = FILE_ICONS[ext];
  if (emoji) return <span className="text-sm flex-shrink-0">{emoji}</span>;
  return <File size={16} className="text-text-secondary flex-shrink-0" />;
}

function TreeNode({ item, depth, activeFile, onFileSelect, onDelete, onRename }: {
  item: FileItem;
  depth: number;
  activeFile: string | null;
  onFileSelect: (path: string) => void;
  onDelete: (path: string) => void;
  onRename: (oldPath: string, newPath: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(item.name);
  const [showActions, setShowActions] = useState(false);
  const isActive = activeFile === item.path;

  const handleClick = () => {
    if (item.is_dir) {
      setExpanded(!expanded);
    } else {
      onFileSelect(item.path);
    }
  };

  const handleRename = () => {
    if (newName && newName !== item.name) {
      const parts = item.path.split('/');
      parts[parts.length - 1] = newName;
      onRename(item.path, parts.join('/'));
    }
    setIsRenaming(false);
  };

  return (
    <div>
      <div
        className={`file-tree-item flex items-center gap-1 px-2 py-[3px] cursor-pointer group ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
        onMouseEnter={() => setShowActions(true)}
        onMouseLeave={() => setShowActions(false)}
      >
        {item.is_dir ? (
          expanded
            ? <ChevronDown size={14} className="text-text-secondary flex-shrink-0" />
            : <ChevronRight size={14} className="text-text-secondary flex-shrink-0" />
        ) : (
          <span className="w-[14px] flex-shrink-0" />
        )}

        {getIcon(item.name, item.is_dir, expanded)}

        {isRenaming ? (
          <input
            className="bg-active-bg text-text-primary text-sm px-1 border border-accent outline-none flex-1 min-w-0"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setIsRenaming(false); }}
            autoFocus
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="text-sm text-text-primary truncate flex-1">{item.name}</span>
        )}

        {showActions && !isRenaming && (
          <div className="flex items-center gap-1 ml-auto" onClick={e => e.stopPropagation()}>
            <button
              className="p-0.5 hover:bg-hover-bg rounded"
              onClick={() => { setNewName(item.name); setIsRenaming(true); }}
              title="重命名"
            >
              <Pencil size={12} className="text-text-secondary" />
            </button>
            <button
              className="p-0.5 hover:bg-hover-bg rounded"
              onClick={() => { if (confirm(`确认删除 ${item.name}？`)) onDelete(item.path); }}
              title="删除"
            >
              <Trash2 size={12} className="text-error" />
            </button>
          </div>
        )}
      </div>

      {item.is_dir && expanded && item.children?.map(child => (
        <TreeNode
          key={child.path}
          item={child}
          depth={depth + 1}
          activeFile={activeFile}
          onFileSelect={onFileSelect}
          onDelete={onDelete}
          onRename={onRename}
        />
      ))}
    </div>
  );
}

export default function FileTree({
  files,
  activeFile,
  workspaceRoot,
  onFileSelect,
  onRefresh,
  onSwitchWorkspace,
  onCreate,
  onDelete,
  onRename,
}: Props) {
  const [showInput, setShowInput] = useState<'file' | 'dir' | null>(null);
  const [inputValue, setInputValue] = useState('');

  const handleCreate = () => {
    if (inputValue.trim()) {
      onCreate(inputValue.trim(), showInput === 'dir');
      setInputValue('');
      setShowInput(null);
    }
  };

  return (
    <div className="h-full flex flex-col bg-sidebar-bg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-color">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider truncate" title={workspaceRoot || ''}>
          资源管理器
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              const current = workspaceRoot || '';
              const target = prompt('输入新的工作目录绝对路径', current);
              if (target && target.trim()) onSwitchWorkspace(target.trim());
            }}
            className="p-1 hover:bg-hover-bg rounded"
            title="切换工作目录"
          >
            <FolderOpen size={14} className="text-text-secondary" />
          </button>
          <button onClick={() => setShowInput('file')} className="p-1 hover:bg-hover-bg rounded" title="新建文件">
            <Plus size={14} className="text-text-secondary" />
          </button>
          <button onClick={() => setShowInput('dir')} className="p-1 hover:bg-hover-bg rounded" title="新建文件夹">
            <FolderPlus size={14} className="text-text-secondary" />
          </button>
          <button onClick={onRefresh} className="p-1 hover:bg-hover-bg rounded" title="刷新">
            <RefreshCw size={14} className="text-text-secondary" />
          </button>
        </div>
      </div>

      {showInput && (
        <div className="px-3 py-2 border-b border-border-color">
          <input
            className="w-full bg-active-bg text-text-primary text-sm px-2 py-1 border border-accent outline-none rounded"
            placeholder={showInput === 'dir' ? '文件夹名称...' : '文件路径 (如 src/main.py)...'}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowInput(null); }}
            autoFocus
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {files.length === 0 ? (
          <div className="text-center text-text-secondary text-sm py-8 px-4">
            <Folder size={32} className="mx-auto mb-2 opacity-50" />
            <p>工作区为空</p>
            <p className="text-xs mt-1">点击上方按钮创建文件</p>
          </div>
        ) : (
          files.map(item => (
            <TreeNode
              key={item.path}
              item={item}
              depth={0}
              activeFile={activeFile}
              onFileSelect={onFileSelect}
              onDelete={onDelete}
              onRename={onRename}
            />
          ))
        )}
      </div>
    </div>
  );
}
