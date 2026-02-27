#!/usr/bin/env python3
"""
测试 OpenRouter API Key 是否有效
"""
import os
import sys
from dotenv import load_dotenv
import httpx

# 加载环境变量
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

api_key = os.getenv("OPENAI_API_KEY", "")
base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
model = os.getenv("OPENAI_MODEL", "gpt-4o")

print("=" * 60)
print("OpenRouter API Key 测试工具")
print("=" * 60)
print(f"\nAPI Key: {api_key[:20]}..." if len(api_key) > 20 else f"\nAPI Key: {api_key}")
print(f"Base URL: {base_url}")
print(f"Model: {model}")
print()

if not api_key:
    print("❌ 错误: OPENAI_API_KEY 未配置")
    sys.exit(1)

# 检查 API Key 格式
if "openrouter.ai" in base_url:
    if not (api_key.startswith("sk-or-v1-") or api_key.startswith("sk-or-")):
        print("⚠️  警告: OpenRouter API Key 格式可能不正确")
        print("   通常应以 'sk-or-v1-' 或 'sk-or-' 开头")
        print()

# 测试 API 调用
print("正在测试 API 连接...")
try:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    
    if "openrouter.ai" in base_url:
        headers["HTTP-Referer"] = "http://localhost:3000"
        headers["X-Title"] = "Nexar Code"
    
    with httpx.Client(timeout=30) as client:
        resp = client.post(
            f"{base_url}/chat/completions",
            headers=headers,
            json={
                "model": model,
                "messages": [{"role": "user", "content": "Hello"}],
                "max_tokens": 10,
            },
        )
        
        print(f"HTTP 状态码: {resp.status_code}")
        
        if resp.status_code == 200:
            data = resp.json()
            print("✅ API Key 有效！")
            print(f"响应: {data.get('choices', [{}])[0].get('message', {}).get('content', '')}")
        elif resp.status_code == 401:
            try:
                error_data = resp.json()
                error_msg = error_data.get("error", {})
                if isinstance(error_msg, dict):
                    error_detail = error_msg.get("message", str(error_msg))
                else:
                    error_detail = str(error_msg)
            except:
                error_detail = resp.text
            
            print("❌ API 认证失败 (401)")
            print(f"错误信息: {error_detail}")
            print()
            print("可能的原因：")
            print("1. API Key 无效或已过期")
            print("2. OpenRouter 账户不存在或未激活")
            print("3. API Key 余额不足")
            print()
            print("解决方案：")
            print("1. 访问 https://openrouter.ai/keys 检查 API Key 状态")
            print("2. 确认 API Key 是否正确复制到 backend/.env 文件")
            print("3. 检查 OpenRouter 账户是否有足够的余额")
        else:
            print(f"❌ API 请求失败")
            print(f"响应: {resp.text}")
            
except httpx.RequestError as e:
    print(f"❌ 网络错误: {e}")
except Exception as e:
    print(f"❌ 发生错误: {e}")

print()
print("=" * 60)
