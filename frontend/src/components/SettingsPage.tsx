import React, { useMemo, useState, useEffect } from 'react';
import { X } from 'lucide-react';

interface Props {
  onClose: () => void;
}

interface SettingsTab {
  id: string;
  label: string;
}

const DEFAULT_TABS: SettingsTab[] = [
  { id: 'general', label: '通用' },
  { id: 'models', label: '模型' },
  { id: 'editor', label: '编辑器' },
  { id: 'terminal', label: '终端' },
  { id: 'about', label: '关于' },
];

export default function SettingsPage({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<string>(DEFAULT_TABS[0].id);
  const activeLabel = useMemo(
    () => DEFAULT_TABS.find(t => t.id === activeTab)?.label || '',
    [activeTab]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-[#0c0f14]/85 backdrop-blur-[2px]">
      <div className="h-full w-full bg-[#12161d] text-text-primary flex">
        <aside className="w-56 border-r border-border-color bg-[#0f131a] p-3">
          <div className="text-xs text-text-secondary uppercase tracking-wider px-2 py-1">Settings</div>
          <div className="mt-2 space-y-1">
            {DEFAULT_TABS.map(tab => (
              <button
                key={tab.id}
                className={`w-full text-left px-2.5 py-1.5 rounded text-sm border ${
                  activeTab === tab.id
                    ? 'bg-accent/20 text-accent border-accent/40'
                    : 'bg-transparent border-transparent hover:bg-hover-bg text-text-secondary'
                }`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </aside>

        <main className="flex-1 flex flex-col min-w-0">
          <div className="h-11 border-b border-border-color flex items-center justify-between px-4">
            <div className="text-sm font-medium">{activeLabel}</div>
            <button
              className="p-1.5 rounded hover:bg-hover-bg text-text-secondary"
              onClick={onClose}
              title="关闭设置"
            >
              <X size={15} />
            </button>
          </div>
          <div className="flex-1 p-6 text-sm text-text-secondary">
            <div className="rounded border border-border-color bg-[#0f131a] p-4">
              {activeLabel} 页面预留中，后续在这里扩展具体配置项。
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
