// Reel interior frames via ffmpeg — reads flyer text baked into the video that
// the cover thumbnail and audio both miss. Local-only: ffmpeg is a heavy binary
// that isn't on Vercel's serverless runtime, so this returns null there and the
// pipeline degrades to caption + cover + audio (a platform limit, not a gap).

import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FRAME_COUNT } from '../config';

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (code) => resolve(code ?? 1));
  });
}

let ffmpegChecked: boolean | null = null;
async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegChecked !== null) return ffmpegChecked;
  try {
    await run('ffmpeg', ['-version']);
    ffmpegChecked = true;
  } catch {
    ffmpegChecked = false;
  }
  return ffmpegChecked;
}

/** Sample `n` evenly-spaced frames as base64 data URLs. Null when unavailable. */
export async function sampleFrames(videoUrl: string, n = FRAME_COUNT): Promise<string[] | null> {
  if (process.env.VERCEL) return null; // serverless: no ffmpeg
  if (!videoUrl.startsWith('https://')) return null;
  if (!(await hasFfmpeg())) return null;

  const dir = await mkdtemp(join(tmpdir(), 'reel-'));
  try {
    const mp4 = join(dir, 'in.mp4');
    const res = await fetch(videoUrl);
    if (!res.ok) return null;
    await writeFile(mp4, Buffer.from(await res.arrayBuffer()));

    // Evenly spaced frames: -vf fps handles unknown duration; scale down to keep
    // the vision payload light.
    await run('ffmpeg', [
      '-i', mp4,
      '-vf', `select='not(mod(n\\,round(max(1\\,${n}))))',scale=640:-1`,
      '-frames:v', String(n),
      '-vsync', 'vfr',
      join(dir, 'f_%02d.jpg'),
    ]);

    const frames: string[] = [];
    for (let i = 1; i <= n; i++) {
      try {
        const b = await readFile(join(dir, `f_${String(i).padStart(2, '0')}.jpg`));
        frames.push(`data:image/jpeg;base64,${b.toString('base64')}`);
      } catch {
        break; // fewer frames than requested (short clip) — take what we got
      }
    }
    return frames.length ? frames : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
