"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTranslations, useLocale } from "next-intl";
import { uploadUrl } from "@/lib/utils/upload-url";
import { useModelStore, type ModelRef } from "@/stores/model-store";
import { Sparkles, Loader2, Copy, Check, ArrowUpCircle, Trash2, ChevronLeft, ChevronRight, Upload, Wand2 } from "lucide-react";
import { InlineModelPicker } from "@/components/editor/model-selector";
import { apiFetch } from "@/lib/api-fetch";
import { useModelGuard } from "@/hooks/use-model-guard";
import { toast } from "sonner";
import { buildCharacterTurnaroundPrompt } from "@/lib/ai/prompts/character-image";

interface CharacterCardProps {
  id: string;
  projectId: string;
  name: string;
  description: string;
  visualHint: string | null;
  t2iStructure?: string | null;
  r2iStructure?: string | null;
  referenceImage: string | null;
  referenceImageHistory?: string | null;
  onUpdate: () => void;
  batchGenerating?: boolean;
  scope?: string;
  onPromote?: () => void;
  onDelete?: () => void;
  episodeName?: string;
  baseName?: string;
  phaseName?: string | null;
  episodeSequences?: string | null;
  visualChanges?: string | null;
  createdAt?: Date | number;
}

export function CharacterCard({
  id,
  projectId,
  name,
  description,
  visualHint,
  t2iStructure,
  r2iStructure,
  referenceImage,
  referenceImageHistory,
  onUpdate,
  batchGenerating,
  scope,
  onPromote,
  onDelete,
  episodeName,
  baseName,
  phaseName,
  episodeSequences,
  visualChanges,
  createdAt,
}: CharacterCardProps) {
  const t = useTranslations();
  const locale = useLocale();
  const getModelConfig = useModelStore((s) => s.getModelConfig);
  const providers = useModelStore((s) => s.providers);
  const defaultImageModel = useModelStore((s) => s.defaultImageModel);
  const [imageModelRef, setImageModelRef] = useState<ModelRef | null>(() => defaultImageModel);
  const [editName, setEditName] = useState(name);
  const [editDesc, setEditDesc] = useState(description);
  const [editVisualHint, setEditVisualHint] = useState(visualHint ?? "");
  const [editT2iStructure, setEditT2iStructure] = useState(t2iStructure ?? "");
  const [editR2iStructure, setEditR2iStructure] = useState(r2iStructure ?? "");

  // Sync local state when props change (e.g. after re-extraction)
  useEffect(() => { setEditName(name); }, [name]);
  useEffect(() => { setEditDesc(description); }, [description]);
  useEffect(() => { setEditVisualHint(visualHint ?? ""); }, [visualHint]);
  useEffect(() => { setEditT2iStructure(t2iStructure ?? ""); }, [t2iStructure]);
  useEffect(() => { setEditR2iStructure(r2iStructure ?? ""); }, [r2iStructure]);
  const [generating, setGenerating] = useState(false);
  const [generatingR2i, setGeneratingR2i] = useState(false);
  const [generatingT2i, setGeneratingT2i] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [copied, setCopied] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const imageGuard = useModelGuard("image");
  const isGenerating = generating || (!!batchGenerating && !referenceImage);

  // Promote to Phase dialog state
  const [promoteDialogOpen, setPromoteDialogOpen] = useState(false);
  const [promotePhaseName, setPromotePhaseName] = useState("默认");
  const [promoteEpisodeSeqs, setPromoteEpisodeSeqs] = useState(episodeSequences || "");
  const [promoteTargetScope, setPromoteTargetScope] = useState("guest");

  function resolveImageRef(ref: ModelRef | null) {
    if (!ref) return null;
    const provider = providers.find((p) => p.id === ref.providerId);
    if (!provider) return null;
    return {
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      secretKey: provider.secretKey,
      modelId: ref.modelId,
    };
  }

  async function handleSave() {
    await apiFetch(`/api/projects/${projectId}/characters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName, description: editDesc, visualHint: editVisualHint, t2iStructure: editT2iStructure, r2iStructure: editR2iStructure }),
    });
    onUpdate();
  }

  async function handleGenerateImage() {
    if (!imageGuard()) return;
    setGenerating(true);
    try {
      const response = await apiFetch(`/api/projects/${projectId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "single_character_image",
          payload: { characterId: id },
          modelConfig: { ...getModelConfig(), image: resolveImageRef(imageModelRef) },
          language: locale,
        }),
      });
      await response.json();
    } catch (err) {
      console.error("Character image error:", err);
      toast.error(t("common.generationFailed"));
    }
    setGenerating(false);
    onUpdate();
  }

  async function handleGenerateR2iPrompt() {
    setGeneratingR2i(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/characters/${id}/r2i-prompt`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.prompt) {
        setEditR2iStructure(data.prompt);
        // Auto-save to DB
        await apiFetch(`/api/projects/${projectId}/characters/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ r2iStructure: data.prompt }),
        });
        onUpdate();
      }
    } catch (err) {
      console.error("R2I prompt error:", err);
      toast.error("生成 R2I Prompt 失败");
    }
    setGeneratingR2i(false);
  }

  async function handleGenerateT2iPrompt() {
    setGeneratingT2i(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/characters/${id}/t2i-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelConfig: { text: getModelConfig().text }, language: locale }),
      });
      const data = await res.json();
      if (data.prompt) {
        setEditT2iStructure(data.prompt);
        // 端点仅在 JSON 合法时入库；否则由卡片 PATCH 兜底保存
        if (!data.saved) {
          await apiFetch(`/api/projects/${projectId}/characters/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ t2iStructure: data.prompt }),
          });
        }
        onUpdate();
      }
    } catch (err) {
      console.error("T2I prompt error:", err);
      toast.error("生成 T2I Prompt 失败");
    }
    setGeneratingT2i(false);
  }

  async function handleUploadImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await apiFetch(`/api/projects/${projectId}/characters/${id}/upload`, {
        method: "POST",
        body: form,
      });
      onUpdate();
    } catch (err) {
      console.error("Character image upload error:", err);
      toast.error(t("common.uploadFailed"));
    }
    setUploading(false);
  }

  return (
    <div className="group overflow-hidden rounded-2xl border border-[--border-subtle] bg-white transition-all duration-300 hover:border-[--border-hover] hover:shadow-lg hover:shadow-black/5">
      {/* Avatar area */}
      <div className="relative flex items-center justify-center bg-gradient-to-b from-[--surface] to-white p-8">
        {onDelete && (
          <button
            onClick={onDelete}
            className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-red-500/80 text-white opacity-0 transition-all hover:bg-red-600 group-hover:opacity-100"
            title={t("common.delete")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {referenceImage ? (() => {
          let history: string[] = [];
          try { history = JSON.parse(referenceImageHistory || "[]"); } catch {}
          if (history.length === 0 && referenceImage) history = [referenceImage];
          const currentIdx = history.indexOf(referenceImage);
          const showArrows = history.length > 1;
          async function switchTo(newPath: string) {
            await apiFetch(`/api/projects/${projectId}/characters/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ referenceImage: newPath }),
            });
            onUpdate();
          }
          return (
            <div className="relative w-full aspect-video overflow-hidden rounded-xl cursor-pointer group" onClick={() => setLightbox(true)}>
              <img
                src={uploadUrl(referenceImage)}
                alt={name}
                className="w-full h-full object-cover"
              />
              {showArrows && (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = (currentIdx - 1 + history.length) % history.length;
                      switchTo(history[next]);
                    }}
                    className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = (currentIdx + 1) % history.length;
                      switchTo(history[next]);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                  <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white">
                    {currentIdx + 1}/{history.length}
                  </span>
                </>
              )}
            </div>
          );
        })() : isGenerating ? (
          <div className="w-full aspect-video rounded-xl animate-shimmer" />
        ) : (
          <div className="flex w-full aspect-video items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-accent/10 text-3xl font-bold text-primary">
            {name.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      {/* Scope badge */}
      {(scope || phaseName || episodeName || baseName) && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          {scope && (
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                scope === "main"
                  ? "bg-blue-100 text-blue-700"
                  : scope === "guest"
                    ? "bg-purple-100 text-purple-700"
                    : "bg-amber-100 text-amber-700"
              }`}
            >
              {scope === "main" ? t("episode.mainCharacter") : scope === "guest" ? "配角" : "客串"}
            </span>
          )}
          {phaseName && (
            <span className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
              {phaseName}
            </span>
          )}
          {phaseName && episodeSequences && (
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
              EP {episodeSequences}
            </span>
          )}
          {episodeName && (
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
              {episodeName}
            </span>
          )}
          {scope === "support" && (
            <button
              onClick={() => setPromoteDialogOpen(true)}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-blue-600 hover:bg-blue-50 transition-colors"
            >
              <ArrowUpCircle className="h-3 w-3" />
              升级为配角
            </button>
          )}
        </div>
      )}

      {/* Info */}
      <div className="space-y-3 p-4">
        <Input
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleSave}
          className="h-9 font-display font-semibold text-base"
        />
        <Textarea
          value={editDesc}
          onChange={(e) => setEditDesc(e.target.value)}
          onBlur={handleSave}
          placeholder={t("character.description")}
          className="h-32 resize-none text-sm"
        />
        <Input
          value={editVisualHint}
          onChange={(e) => setEditVisualHint(e.target.value)}
          onBlur={handleSave}
          placeholder={t("character.visualHint")}
          className="h-8 text-xs text-muted-foreground"
        />
        {!phaseName && (
          <details className="text-xs">
            <summary className="flex cursor-pointer items-center gap-1.5 font-semibold text-[--text-primary]">
              <Wand2 className="h-3.5 w-3.5" />
              T2I Prompt (Qwen structured prompt)
            </summary>
            <div className="mt-2 space-y-2">
              <Textarea
                value={editT2iStructure}
                onChange={(e) => setEditT2iStructure(e.target.value)}
                onBlur={handleSave}
                placeholder='[age] 71-year-old, frail
[subject] male, 162cm, thin, hunched
[body] narrow shoulders, loose skin, bowed back
[face] deep wrinkles, sunken cheeks, age spots
[hair] sparse white hair, wispy beard
[clothing] faded dragon robe, too large, sags at shoulders
[lighting] warm front light, soft shadows'
                className="h-24 resize-none text-xs font-mono"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={handleGenerateT2iPrompt}
                disabled={generatingT2i}
                className="w-full text-[11px]"
              >
                {generatingT2i ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : (
                  <Wand2 className="mr-1.5 h-3 w-3" />
                )}
                生成 T2I 提示词
              </Button>
            </div>
          </details>
        )}
        {phaseName && (
          <details className="text-xs">
            <summary className="flex cursor-pointer items-center gap-1.5 font-semibold text-[--text-primary]">
              <Wand2 className="h-3.5 w-3.5" />
              R2I Prompt (Phase reference image)
            </summary>
            <div className="mt-2 space-y-2">
              <Textarea
                value={editR2iStructure}
                onChange={(e) => setEditR2iStructure(e.target.value)}
                onBlur={handleSave}
                placeholder="点击下方按钮生成 R2I Prompt..."
                className="h-24 resize-none text-xs font-mono"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={handleGenerateR2iPrompt}
                disabled={generatingR2i}
                className="w-full text-[11px]"
              >
                {generatingR2i ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="mr-1.5 h-3 w-3" />
                )}
                生成 R2I Prompt
              </Button>
            </div>
          </details>
        )}
        <div className="space-y-2">
            <InlineModelPicker capability="image" value={imageModelRef} onChange={setImageModelRef} />
            <div className="flex gap-2">
              <Button
                onClick={handleGenerateImage}
                disabled={isGenerating}
                className="flex-1"
                size="sm"
              >
                {isGenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {isGenerating ? t("common.generating") : t("character.generateImage")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 px-2.5"
                title={t("character.uploadImage")}
                disabled={uploading}
                onClick={() => uploadInputRef.current?.click()}
              >
                {uploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 px-2.5"
                title="Copy image prompt"
                onClick={async () => {
                  const prompt = buildCharacterTurnaroundPrompt(editDesc || editName, editName);
                  await navigator.clipboard.writeText(prompt);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
      </div>

      {referenceImage && (
        <Dialog open={lightbox} onOpenChange={setLightbox}>
          <DialogContent className="!max-w-[90vw] !w-[90vw] border-0 bg-transparent p-0 shadow-none" showCloseButton={false}>
            <DialogTitle className="sr-only">{name}</DialogTitle>
            <div className="relative inline-block w-full">
              <img
                src={uploadUrl(referenceImage)}
                alt={name}
                className="w-full max-h-[85vh] object-contain rounded-xl"
              />
              <button
                onClick={() => setLightbox(false)}
                className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
              >
                <span className="text-sm leading-none">✕</span>
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Promote to Phase Dialog */}
      <Dialog open={promoteDialogOpen} onOpenChange={setPromoteDialogOpen}>
        <DialogContent className="!max-w-md">
          <DialogTitle>升级为视觉阶段</DialogTitle>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-sm font-medium text-[--text-primary]">阶段名称</label>
              <Input
                value={promotePhaseName}
                onChange={(e) => setPromotePhaseName(e.target.value)}
                placeholder="例如: 默认、变身、觉醒"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-[--text-primary]">EP 序列</label>
              <Input
                value={promoteEpisodeSeqs}
                onChange={(e) => setPromoteEpisodeSeqs(e.target.value)}
                placeholder="例如: 1,2,3,5"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-[--text-primary]">角色级别</label>
              <div className="mt-1 flex gap-2">
                <button
                  onClick={() => setPromoteTargetScope("main")}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    promoteTargetScope === "main"
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-[--border-subtle] text-[--text-muted] hover:border-[--border-hover]"
                  }`}
                >
                  主角
                </button>
                <button
                  onClick={() => setPromoteTargetScope("guest")}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    promoteTargetScope === "guest"
                      ? "border-purple-500 bg-purple-50 text-purple-700"
                      : "border-[--border-subtle] text-[--text-muted] hover:border-[--border-hover]"
                  }`}
                >
                  配角
                </button>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setPromoteDialogOpen(false)}>
                取消
              </Button>
              <Button
                onClick={async () => {
                  if (!promotePhaseName.trim()) return;
                  await apiFetch(`/api/projects/${projectId}/characters/${id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      phaseName: promotePhaseName.trim(),
                      episodeSequences: promoteEpisodeSeqs,
                      scope: promoteTargetScope,
                    }),
                  });
                  setPromoteDialogOpen(false);
                  onUpdate();
                }}
              >
                确认升级
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Hidden file input for image upload */}
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleUploadImage}
      />
    </div>
  );
}
