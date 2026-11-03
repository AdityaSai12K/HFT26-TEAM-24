import type { BoardId, Quad, Scene } from "./types";

export const API_URL = process.env.NEXT_PUBLIC_VISION_API ?? "http://localhost:8000";

export interface DetectOptions {
  board?: BoardId | null;
  quad?: Quad | null;
  /** False skips part naming, for live frames in between full ones. */
  full?: boolean;
  signal?: AbortSignal;
}

export class VisionError extends Error {}

export async function detect(image: Blob, options: DetectOptions = {}): Promise<Scene> {
  const form = new FormData();
  form.append("image", image, "frame.jpg");
  if (options.board) form.append("board", options.board);
  if (options.quad) form.append("quad", JSON.stringify(options.quad));
  form.append("full", String(options.full ?? true));

  let response: Response;
  try {
    response = await fetch(`${API_URL}/detect`, { method: "POST", body: form, signal: options.signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new VisionError("The vision service is not reachable. Start it with: uvicorn app.main:app --port 8000");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new VisionError(body?.detail ?? `The vision service returned ${response.status}.`);
  }
  return response.json();
}

export async function visionHealthy(): Promise<boolean> {
  try {
    return (await fetch(`${API_URL}/health`)).ok;
  } catch {
    return false;
  }
}

export async function loadSample(id: string): Promise<{ scene: Scene; url: string }> {
  const response = await fetch(`/samples/${id}.json`);
  return { scene: await response.json(), url: `/samples/${id}.jpg` };
}
