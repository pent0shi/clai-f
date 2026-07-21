import type { Mode, ProviderId, ChatImage } from "../types.js";
import {
  modelSupportsVision,
  preferredVisionModel,
  visionCapabilitySource,
} from "../llm/capabilities.js";
import { safeCwd } from "../os/cwd.js";
import {
  expandMentions,
  loadImagePaths,
  type Attachment,
} from "../ui/mentions.js";

export interface ResolvedTurnInput {
  readonly prompt: string;
  readonly mode: Mode;
  readonly provider: ProviderId;
  readonly model: string;
  readonly attachments: readonly Attachment[];
  readonly images: readonly ChatImage[];
  readonly capability: {
    readonly vision: boolean;
    readonly source: "provider" | "user" | "fallback-table";
  };
  readonly fallbackReason?: string | undefined;
}

/** Shared frontend-neutral attachment and same-provider vision resolution. */
export function resolveTurnInput(input: {
  prompt: string;
  mode: Mode;
  provider: ProviderId;
  model: string;
  baseDir?: string | undefined;
}): ResolvedTurnInput {
  const baseDir = input.baseDir ?? safeCwd();
  let model = input.model;
  let vision = modelSupportsVision(input.provider, model);
  let expansion = expandMentions(input.prompt, baseDir, vision);
  const hasImage = expansion.attachments.some((attachment) => attachment.kind === "image");
  let fallbackReason: string | undefined;
  if (hasImage && !vision) {
    const fallback = preferredVisionModel(input.provider, model);
    if (fallback) {
      model = fallback;
      vision = true;
      fallbackReason =
        `Selected same-provider vision model ${fallback} because the request contains an image ` +
        `(capability source: ${visionCapabilitySource(input.provider, fallback)}).`;
      expansion = expandMentions(input.prompt, baseDir, true);
    }
  }
  const images = vision
    ? loadImagePaths(
        expansion.attachments
          .filter((attachment) => attachment.kind === "image")
          .map((attachment) => attachment.path),
      )
    : [];
  const prompt = expansion.contextBlock
    ? `${expansion.text}\n\n${expansion.contextBlock}`
    : expansion.text;
  return {
    prompt,
    mode: input.mode,
    provider: input.provider,
    model,
    attachments: expansion.attachments,
    images,
    capability: {
      vision,
      source: visionCapabilitySource(input.provider, model),
    },
    fallbackReason,
  };
}

/** Vision-first OCR policy shared by frontends. */
export function shouldRunImageOcr(input: {
  hasImage: boolean;
  visionCapable: boolean;
  prompt: string;
}): boolean {
  if (!input.hasImage || input.visionCapable) return false;
  return /\b(?:ocr|extract|transcribe|read)\b[\s\S]{0,30}\btext\b|\btext\b[\s\S]{0,30}\b(?:image|screenshot)\b/i.test(
    input.prompt,
  );
}
