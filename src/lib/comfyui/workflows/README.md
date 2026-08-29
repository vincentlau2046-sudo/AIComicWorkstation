# ComfyUI Workflow Mirror

This directory mirrors the production workflows used by AIComicWorkstation.
Production path: /home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/

These files are kept in git for version tracking. The production runtime
reads from the ComfyUI installation path directly via COMFYUI_WORKFLOWS_DIR
(specified as `process.env.COMFYUI_WORKFLOWS_DIR || "/home/vince/ComfyUI/workflows/AIComicWorkstation/atomic"`).

**修改后必须同步到生产目录**，否则 runtime 不生效。

## Backup Convention

When modifying a workflow JSON, always create a timestamped backup first:

```bash
cp <file>.json <file>.json.bak-$(date +%Y%m%d)
```

Backups live in the same directory as the original files.

## Sync command

```bash
# AICW source → production (修改后必做)
cp src/lib/comfyui/workflows/atomic/h3-*.json /home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/
cp src/lib/comfyui/workflows/atomic/qwen-*.json /home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/

# Production → AICW source (回拉生产最新版本)
cp /home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/*.json src/lib/comfyui/workflows/atomic/
cp /home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/*.yaml src/lib/comfyui/workflows/atomic/
```

## Modifications (2026-08-27)

### h3-i2v.json (FL2V) — +2 nodes

| Node ID | Class | Purpose |
|---------|-------|---------|
| 21 | `LoraLoaderModelOnly` | Motion Adapter LoRA (`strength_model=1.0`) |
| 22 | `ImageScale` | Lanczos upscale to 1280×720 |

| Changed connection | Before | After |
|-------------------|--------|-------|
| `SigmaShift(5).model` | `[2, 0]` (UNETLoader) | `[21, 0]` (LoRA node) |
| `CreateVideo(16).images` | `[14, 0]` (VAEDecode) | `[22, 0]` (ImageScale node) |
| `CreateVideo(16).audio` | `[15, 0]` (VAEDecodeAudio) | **unchanged** — audio bypass |

### h3-r2v.json (R2V) — +2 nodes

| Node ID | Class | Purpose |
|---------|-------|---------|
| 20 | `LoraLoaderModelOnly` | Motion Adapter LoRA (`strength_model=1.0`) |
| 21 | `ImageScale` | Lanczos upscale to 1280×720 |

| Changed connection | Before | After |
|-------------------|--------|-------|
| `SigmaShift(10).model` | `[2, 0]` (UNETLoader) | `[20, 0]` (LoRA node) |
| `CreateVideo(18).images` | `[16, 0]` (VAEDecode) | `[21, 0]` (ImageScale node) |
| `CreateVideo(18).audio` | `[17, 0]` (VAEDecodeAudio) | **unchanged** — audio bypass |

### Required LoRA files

```
ComfyUI/models/loras/minimax_h3/minimax_h3_motion_adapter_pilot_r16.safetensors  (61 MB)
ComfyUI/models/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors   (1.9 GB)  # optional
ComfyUI/models/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors   (1.9 GB)  # optional
```

### Backup files

- `/tmp/h3-i2v.json.bak` — pre-modification original
- `/tmp/h3-r2v.json.bak` — pre-modification original
- `/home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/h3-i2v.json.bak` — production directory backup
- `/home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/h3-r2v.json.bak` — production directory backup

## Restoration (2026-08-28) — OOM fix

### Context

The Motion Adapter + Turbo LoRA additions (Aug 27) pushed H3 VRAM over 32GB on RTX 5090D.
Turbo LoRA (`minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors`, 978M params BF16 model diff)
requires ~48-50GB peak VRAM per inference, incompatible with 32GB 5090D.

### Changes

1. **Workflows restored to baseline** (git `3aedb1e`, 0 LoRA nodes):
   - `h3-i2v.json` — removed LoraLoaderModelOnly (node 23)
   - `h3-r2v.json` — removed both LoraLoaderModelOnly nodes (nodes 22, 23)

2. **ComfyUI startup**: removed `--cache-none` flag
   - Default RAM-pressure caching skips 32B text encoder on re-runs, lowering VRAM peak
   - See: kingy.ai H3 guide, ComfyUI-H3-YT-guide

### Current running state

- Workflow: baseline (no LoRA)
- ComfyUI flags: `--listen 0.0.0.0 --port 8188 --enable-manager`
- Backup of pre-restoration workflows: `.current_bak` files in production directory

### To restore Turbo LoRA workflow (when/if needed)

```bash
cp /home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/h3-i2v.json.current_bak \
   /home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/h3-i2v.json
cp /home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/h3-r2v.json.current_bak \
   /home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/h3-r2v.json
# Re-add --cache-none to start_with_mirror.sh
# Restart ComfyUI
```

### LoRA files (kept for future use)

```
ComfyUI/models/loras/minimax_h3/minimax_h3_motion_adapter_pilot_r16.safetensors
ComfyUI/models/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
ComfyUI/models/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors
ComfyUI/models/loras/minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors
```
