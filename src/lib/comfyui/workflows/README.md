# ComfyUI Workflow Mirror

This directory mirrors the production workflows used by AIComicWorkstation.
Production path: /home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/

These files are kept in git for version tracking. The production runtime
reads from the ComfyUI installation path directly via COMFYUI_WORKFLOWS_DIR.

## Sync command

```bash
cp /home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/*.json src/lib/comfyui/workflows/atomic/
cp /home/vince/ComfyUI/workflows/AIComicWorkstation/atomic/*.yaml src/lib/comfyui/workflows/atomic/
```
