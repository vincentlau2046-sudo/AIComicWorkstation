/**
 * 导出版本命名工具
 *
 * 命名规范: {projectTitle}-EP{sequence:pad2}-{epTitle}.{ext}
 * 示例:    洪武悍卒-EP09-火烧粮营.mp4
 */

import path from "path";
import { getUploadDir } from "@/lib/env";

/**
 * 构建导出版本的文件名（不含扩展名）
 */
export function buildExportName(opts: {
  projectTitle: string;
  epSequence: number;
  epTitle: string;
}): string {
  const seq = String(opts.epSequence).padStart(2, "0");
  const raw = `${opts.projectTitle}-EP${seq}-${opts.epTitle}`;
  return sanitizeFilename(raw);
}

/**
 * 构建导出目录下的完整路径
 */
export function buildExportPath(opts: {
  projectTitle: string;
  epSequence: number;
  epTitle: string;
  ext: string; // ".mp4" | ".md"
}): string {
  const baseName = buildExportName(opts);
  const ext = opts.ext.startsWith(".") ? opts.ext : `.${opts.ext}`;
  return path.resolve(getExportDir(), `${baseName}${ext}`);
}

/**
 * 获取导出根目录
 */
export function getExportDir(): string {
  return path.resolve(getUploadDir(), "export");
}

/**
 * 文件名安全化
 * - 替换文件系统非法字符为连字符
 * - 首尾去空白
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}