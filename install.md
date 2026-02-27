# Nexar Code - 智能编程助手 (VIP)

一套前后端分离的 AI 编程助手系统。React 前端提供 VS Code 风格的代码编辑器与 AI 对话窗口，Python FastAPI 后端对接多模型（OpenAI / Claude / 自定义），支持代码目录管理、文件管理、语法高亮、AI 生成文件和修改文件。

## 功能特性

- **代码编辑器** — 基于 Monaco Editor（VS Code 同款内核），支持语法高亮、代码补全、多标签页
- **文件树管理** — 新建/删除/重命名文件和文件夹，实时刷新
- **AI 多模型支持** — 可切换 OpenAI、Claude、自定义 OpenAI 兼容接口
- **AI 生成文件** — 通过自然语言描述，让 AI 直接生成新文件并写入工作区
- **AI 修改文件** — 选中当前打开的文件，让 AI 对其进行优化/重构/修复
- **AI 对话** — 自由提问编程问题，AI 提供解答和代码示例
- **深色主题** — VS Code 风格暗色 UI，长时间编码不伤眼

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + TypeScript + Vite |
| 编辑器 | Monaco Editor (@monaco-editor/react) |
| UI 样式 | Tailwind CSS |
| 图标 | Lucide React |
| 后端 | Python FastAPI |
| AI 模型 | OpenAI SDK / Anthropic SDK / httpx (自定义) |
| 数据校验 | Pydantic v2 |

## 项目结构

```
codegen/
├── backend/                    # Python 后端
│   ├── main.py                 # FastAPI 入口
│   ├── requirements.txt        # Python 依赖
│   ├── .env.example            # 环境变量模板
│   ├── models/
│   │   └── schemas.py          # Pydantic 数据模型
│   ├── routers/
│   │   ├── files.py            # 文件管理 API
│   │   └── ai.py               # AI 对话 API
│   └── services/
│       ├── file_service.py     # 文件操作逻辑
│       └── ai_service.py       # AI 多模型调用
├── frontend/                   # React 前端
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts          # Vite 配置（含 API 代理）
│   ├── tailwind.config.js
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx            # 入口
│       ├── App.tsx             # 主应用（状态管理 & 布局）
│       ├── index.css           # 全局样式
│       ├── api/
│       │   └── index.ts        # 后端 API 封装
│       └── components/
│           ├── FileTree.tsx     # 文件树组件
│           ├── CodeEditor.tsx   # Monaco 编辑器组件
│           └── ChatPanel.tsx    # AI 对话面板
└── workspace/                  # 工作区目录（AI 读写文件的地方）
```

## 快速开始

### 前置要求

- Python 3.11+
- Node.js 18+
- npm 或 yarn

### 1. 克隆项目

```bash
cd /path/to/codegen
```

### 2. 启动后端

```bash
# 创建虚拟环境
cd backend
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的 API Key

# 启动服务 (默认 8000 端口)
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

> **注意：** 需要在项目根目录 `codegen/` 下运行 uvicorn，因为模块路径是 `backend.main:app`。

```bash
# 在 codegen/ 目录下运行
cd /path/to/codegen
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### 3. 启动前端

```bash
# 新开终端
cd frontend

# 安装依赖
npm install

# 启动开发服务器 (默认 3000 端口)
npm run dev
```

### 4. 访问

浏览器打开 [http://localhost:3000](http://localhost:3000)

## 环境变量配置

在 `backend/.env` 中配置 AI 模型（至少配置一个）：

```env
# OpenAI
OPENAI_API_KEY=sk-your-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o

# Claude
ANTHROPIC_API_KEY=sk-ant-your-key
ANTHROPIC_MODEL=claude-sonnet-4-20250514

# 自定义 OpenAI 兼容接口（如 Ollama、vLLM、LocalAI 等）
CUSTOM_API_KEY=your-key
CUSTOM_BASE_URL=http://localhost:11434/v1
CUSTOM_MODEL=llama3

# 工作区目录
WORKSPACE_ROOT=../workspace
```

## API 接口

### 文件管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/files/tree?path=` | 获取文件树 |
| GET | `/api/files/read?path=xxx` | 读取文件内容 |
| POST | `/api/files/write` | 写入/保存文件 |
| POST | `/api/files/create` | 新建文件/文件夹 |
| POST | `/api/files/delete` | 删除文件/文件夹 |
| POST | `/api/files/rename` | 重命名 |

### AI 服务

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/ai/chat` | AI 对话/生成/修改 |
| GET | `/api/ai/providers` | 获取可用模型列表 |

### 健康检查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 服务状态 |

## 使用方式

### 文件管理
- 左侧文件树支持新建文件/文件夹、重命名、删除
- 点击文件在编辑器中打开，支持多标签页切换
- `Ctrl+S` / `Cmd+S` 保存当前文件

### AI 对话
- **对话模式**：自由提问编程问题
- **生成模式**：输入文件路径和描述，AI 生成完整文件并写入工作区
- **修改模式**：AI 读取当前打开的文件，根据描述修改后写回

### 切换 AI 模型
- 点击 AI 面板右上角设置图标，在下拉菜单中切换模型

## 开发说明

- 前端开发服务器 (Vite) 已配置代理，`/api` 请求自动转发到后端 `localhost:8000`
- `workspace/` 目录为 AI 和用户的文件读写区域，与系统其他目录隔离
- 后端对文件路径做了安全校验，防止目录遍历攻击

## License

MIT
