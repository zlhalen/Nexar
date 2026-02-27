
# Nexar ⬛️
> The White-Box AI Editor for Hackers. | 为极客打造的白盒 AI 编辑器。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Status: v1.0 Alpha](https://img.shields.io/badge/Status-v1.0_Alpha-blue.svg)]()

Tired of AI IDEs treating you like a beginner? Tired of hidden "system prompts" making decisions for your codebase? 

**Nexar** is not just another AI coding assistant. It's a **white-box, highly hackable AI layer** built for senior developers. We believe the AI should be your executor, while *you* remain the architect. 

## 🎯 The Core Philosophy: See It, Tweak It, Control It

In Nexar, there is no "black-box magic". Everything is transparent.

- 👁️ **100% Transparent (可感):** Know exactly what you are paying for. Nexar exposes the exact prompt compilation process. You can inspect the injected codebase contexts, hidden AST structures, and system instructions before a single token is sent to the LLM.
- ⚙️ **Deeply Hackable (可调):** Don't like how the AI formats your code? Change it. Nexar allows you to write custom XML prompt templates in your `.nexarprompts/` directory. Instruct the AI strictly—for example, demanding it to write algorithms strictly in $O(N \log N)$ time complexity instead of $O(N^2)$.
- ⚖️ **Fully Controllable (可控):** You own the Speed / Quality / Cost triangle. 
  - Need speed and zero cost for simple auto-fixes? Route it to a local `Llama-3` via Ollama.
  - Doing a massive architecture refactor? Route it to `Claude-3.5-Sonnet` via your own API Key (BYOK). 
  - Stop paying flat monthly fees for tools you can't control.

## 📦 Installation

This is the v1.0 release. Install the core extension locally:

```bash
git clone https://github.com/yourusername/nexar.git
cd nexar
npm install
npm run build
```

Then, configure your API keys or local AI endpoints in the `nexar.config.json` file.

## 🗺 Roadmap & VIP Features

<details>
<summary><b>Click to expand our vision for V2.0+ and VIP features</b></summary>

Currently, we are focusing on mastering the "White-Box Pipeline". In future/VIP releases, we plan to introduce:

- **AI-Piping (`|`)**: Chain LLM outputs with local CLI tools (e.g., `Prompt -> AI -> | prettier -> file`).
- **Sandbox Dry-Run**: Let AI execute terminal commands in a safe, rollback-able Docker container before touching your real environment.
- **Dynamic Context Graph**: A visual knowledge graph of your local codebase, allowing you to manually draw implicit relations between files to guide the AI's generation.

</details>

## 📄 License

[MIT License](LICENSE)
