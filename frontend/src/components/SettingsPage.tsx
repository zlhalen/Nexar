import React, { useMemo, useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { HistoryConfig } from '../api';

interface Props {
  onClose: () => void;
  historyConfig: HistoryConfig;
  onHistoryConfigChange: (cfg: HistoryConfig) => void;
}

interface SettingsTab {
  id: string;
  label: string;
}

const DEFAULT_TABS: SettingsTab[] = [
  { id: 'general', label: '通用' },
  { id: 'history', label: '历史' },
  { id: 'models', label: '模型' },
  { id: 'editor', label: '编辑器' },
  { id: 'terminal', label: '终端' },
  { id: 'about', label: '关于' },
];

export default function SettingsPage({ onClose, historyConfig, onHistoryConfigChange }: Props) {
  const [activeTab, setActiveTab] = useState<string>(DEFAULT_TABS[0].id);
  const [draftHistory, setDraftHistory] = useState<HistoryConfig>(historyConfig);
  const activeLabel = useMemo(
    () => DEFAULT_TABS.find(t => t.id === activeTab)?.label || '',
    [activeTab]
  );

  useEffect(() => {
    setDraftHistory(historyConfig);
  }, [historyConfig]);

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
            {activeTab === 'history' ? (
              <div className="rounded border border-border-color bg-[#0f131a] p-4 space-y-4">
                <div className="text-sm text-text-primary">历史会话处理</div>
                <label className="block space-y-1">
                  <div className="text-xs text-text-secondary">保留轮次（最近消息数）</div>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={draftHistory.turns}
                    onChange={e => setDraftHistory(prev => ({ ...prev, turns: Number(e.target.value) || 1 }))}
                    className="w-full bg-active-bg text-text-primary text-sm px-2 py-1 rounded border border-border-color outline-none"
                  />
                </label>
                <label className="block space-y-1">
                  <div className="text-xs text-text-secondary">每条最大长度（字符）</div>
                  <input
                    type="number"
                    min={200}
                    max={20000}
                    value={draftHistory.max_chars_per_message}
                    onChange={e => setDraftHistory(prev => ({ ...prev, max_chars_per_message: Number(e.target.value) || 200 }))}
                    className="w-full bg-active-bg text-text-primary text-sm px-2 py-1 rounded border border-border-color outline-none"
                  />
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draftHistory.summary_enabled}
                    onChange={e => setDraftHistory(prev => ({ ...prev, summary_enabled: e.target.checked }))}
                  />
                  <span className="text-sm text-text-primary">启用早期历史摘要</span>
                </label>
                <label className="block space-y-1">
                  <div className="text-xs text-text-secondary">摘要最大长度（字符）</div>
                  <input
                    type="number"
                    min={200}
                    max={10000}
                    value={draftHistory.summary_max_chars}
                    onChange={e => setDraftHistory(prev => ({ ...prev, summary_max_chars: Number(e.target.value) || 200 }))}
                    disabled={!draftHistory.summary_enabled}
                    className="w-full bg-active-bg text-text-primary text-sm px-2 py-1 rounded border border-border-color outline-none disabled:opacity-50"
                  />
                </label>
                <div className="flex items-center gap-2">
                  <button
                    className="px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-hover"
                    onClick={() => onHistoryConfigChange({
                      turns: Math.max(1, Math.min(200, draftHistory.turns)),
                      max_chars_per_message: Math.max(200, Math.min(20000, draftHistory.max_chars_per_message)),
                      summary_enabled: draftHistory.summary_enabled,
                      summary_max_chars: Math.max(200, Math.min(10000, draftHistory.summary_max_chars)),
                    })}
                  >
                    保存
                  </button>
                  <button
                    className="px-3 py-1.5 rounded border border-border-color hover:bg-hover-bg"
                    onClick={() => setDraftHistory(historyConfig)}
                  >
                    重置
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded border border-border-color bg-[#0f131a] p-4">
                {activeLabel} 页面预留中，后续在这里扩展具体配置项。
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
