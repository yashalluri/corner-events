// Reel audio → transcript (gpt-4o-transcribe). One of the multimodal signals
// the extractor uses for videos — a spoken "this Friday at X" is often the only
// place the event details live. Failure is non-fatal: returns null, and the
// extractor falls back to caption + cover + frames.

import OpenAI, { toFile } from 'openai';
import { MAX_VIDEO_BYTES, TRANSCRIBE_MODEL, env } from '../config';

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

export async function transcribeVideo(videoUrl: string): Promise<string | null> {
  if (!env.openai() || !videoUrl.startsWith('https://')) return null;
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_VIDEO_BYTES) return null; // too big for the transcription API
    const file = await toFile(buf, 'reel.mp4', { type: 'video/mp4' });
    const out = await openai().audio.transcriptions.create({
      model: TRANSCRIBE_MODEL,
      file,
      language: 'en',
    });
    const text = out.text?.trim();
    return text ? text : null;
  } catch {
    return null; // one bad video never kills a post
  }
}
