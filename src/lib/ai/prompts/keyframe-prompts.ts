/**
 * User-side prompt builder for the keyframe (first/last frame) image-prompt
 * generation step. Mirrors `buildRefImagePromptsRequest` for the reference
 * mode pipeline. The system prompt lives in the registry under the
 * `shot_split_keyframe_assets` key.
 */

export function buildKeyframePromptsRequest(
  shots: Array<{
    sequence: number;
    prompt: string;
    videoScript?: string | null;
    dialogues?: string;
    motionScript?: string | null;
    cameraDirection?: string | null;
  }>,
  characters: Array<{
    name: string;
    description?: string | null;
    visualHint?: string | null;
  }>,
  visualStyle?: string,
  eraText?: string
): string {
  const charDescriptions = characters
    .map(
      (c) =>
        `${c.name}: ${c.description || ""}`
    )
    .join("\n");

  const shotDescriptions = shots
    .map(
      (s) =>
        `镜头 ${s.sequence}: ${s.prompt}${
          s.motionScript ? `\n动作: ${s.motionScript}` : ""
        }${s.cameraDirection ? `\n镜头运动: ${s.cameraDirection}` : ""}`
    )
    .join("\n\n");

  const styleLine = visualStyle ? `视觉风格: ${visualStyle}` : "";
  const eraLine = eraText ? `时代美学: ${eraText}` : "";
  const header = [styleLine, eraLine].filter(Boolean).join("\n");
  return `${header ? header + "\n\n" : ""}角色:\n${charDescriptions}\n\n分镜:\n${shotDescriptions}`;
}
