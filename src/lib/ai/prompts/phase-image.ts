export function buildPhaseR2IPrompt(params: {
  characterName: string;
  phaseName: string;
  visualChanges: Record<string, string>;
  templateDescription: string;
  /** Registry-resolved "keep the same ..." instruction; falls back to the built-in default when undefined. */
  preserveLine?: string;
}): string {
  const { characterName, phaseName, visualChanges, templateDescription, preserveLine } = params;

  // Detect language from templateDescription (Chinese if contains CJK characters)
  const isChinese = /[\u4e00-\u9fff]/.test(templateDescription);

  if (isChinese) {
    const changeParts: string[] = [];
    if (visualChanges.faceAge) changeParts.push(`${visualChanges.faceAge}`);
    if (visualChanges.clothing) changeParts.push(`穿着${visualChanges.clothing}`);
    if (visualChanges.hairStyle) changeParts.push(`发型为${visualChanges.hairStyle}`);
    if (visualChanges.posture) changeParts.push(`${visualChanges.posture}`);
    if (visualChanges.accessories) changeParts.push(`佩戴${visualChanges.accessories}`);
    if (visualChanges.expression) changeParts.push(`${visualChanges.expression}`);

    const changesLine = changeParts.join("；");
    const zhDefaultPreserve = "保持相同的面部骨骼结构、眼型、鼻型、唇形和身体比例；保持相同的肤色和体格；保持相同的画风和光照质量；保持纯白背景和专业摄影棚布光。其他一切保持不变。";
    return `${characterName}（${phaseName}）。${changesLine}。${preserveLine || zhDefaultPreserve}`;
  }

  // English (original)
  const styleHint = (templateDescription.match(/^[^—]+/) || ["photorealistic"])[0];

  const changeParts: string[] = [];
  if (visualChanges.faceAge) changeParts.push(`appear ${visualChanges.faceAge}`);
  if (visualChanges.clothing) changeParts.push(`wear ${visualChanges.clothing}`);
  if (visualChanges.hairStyle) changeParts.push(`have ${visualChanges.hairStyle}`);
  if (visualChanges.posture) changeParts.push(`stand with ${visualChanges.posture}`);
  if (visualChanges.accessories) changeParts.push(`with ${visualChanges.accessories}`);
  if (visualChanges.expression) changeParts.push(`have ${visualChanges.expression} expression`);

  const changesLine = changeParts.join("; ");
  const enDefaultPreserve = [
    "keep the same facial bone structure, eye shape, nose shape, lip shape, and body proportions",
    "preserve the same skin tone and overall physique",
    "keep the same art style and lighting quality",
    "maintain white background with professional studio lighting",
  ].join("; ");

  return `${characterName} (${phaseName}). ${changesLine}. ${preserveLine || enDefaultPreserve}. Keep everything else unchanged.`;
}
