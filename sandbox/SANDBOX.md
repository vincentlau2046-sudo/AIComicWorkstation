# AIComicWorkstation Sandbox

> 🚧 所有修改必须在此 sandbox 中完成，验证通过后同步到生产环境

## 目录映射

| 路径 | 用途 |
|------|------|
| `/home/vince/projects/AIComicWorkstation-sandbox/` | 🚧 沙箱（开发+验证） |
| `/home/vince/projects/AIComicWorkstation/` | 🏭 生产环境（仅从 sandbox 同步） |
| `~/ComfyUI/workflows/AIComicWorkstation/` | ComfyUI 工作流文件 |

## 修改流程

```
sandbox 修改 → 本地验证（build/lint/功能测试）→ diff 对比 → cp 合入生产 → git commit
```

**禁止直接修改生产环境**（`/home/vince/projects/AIComicWorkstation/`）

## 同步命令

```bash
# 查看 sandbox vs 生产的 diff
diff -rq /home/vince/projects/AIComicWorkstation-sandbox/src/ /home/vince/projects/AIComicWorkstation/src/

# 同步指定文件到生产
cp /home/vince/projects/AIComicWorkstation-sandbox/src/lib/ai/providers/comfyui-provider.ts \
   /home/vince/projects/AIComicWorkstation/src/lib/ai/providers/

# 同步全部（谨慎）
rsync -av --exclude='node_modules' --exclude='.next' --exclude='.git' \
  /home/vince/projects/AIComicWorkstation-sandbox/ /home/vince/projects/AIComicWorkstation/
```
