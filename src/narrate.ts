// Keep ambient audio, then hold the final frame while sentence and word narration play.
import { statSync } from 'node:fs';

/** Probe actual media duration without requiring a shell or a Python arithmetic subprocess. */
function probe(path: string, args: string[]): string {
  const p = Bun.spawnSync(['ffprobe', '-v', 'error', ...args, path]);
  if (p.exitCode) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

/** Match the old audio ordering, channel format, still-frame duration and codecs. */
function narrate(args: string[]): number {
  if (args.length !== 4) throw new Error('Usage: scene-narrate VIDEO SENTENCE WORD OUTPUT');
  const [video = '', sentence = '', word = '', output = ''] = args;
  for (const path of [video, sentence, word])
    if (!statSync(path).size) throw new Error(`scene-narrate: ${path} is empty`);
  const duration = (path: string) =>
    Number(probe(path, ['-show_entries', 'format=duration', '-of', 'csv=p=0']));
  const videoDuration = duration(video);
  const narration = (duration(sentence) + 0.5 + duration(word)).toFixed(3);
  const hasAudio =
    probe(video, ['-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0']) !==
    '';
  const ambient = hasAudio
    ? ['-i', video]
    : ['-f', 'lavfi', '-t', String(videoDuration), '-i', 'anullsrc=r=48000:cl=mono'];
  const format = 'aformat=sample_rates=48000:channel_layouts=mono';
  const filter = `[0:v]tpad=stop_mode=clone:stop_duration=${narration}[v];[1:a]atrim=0:${videoDuration},asetpts=N/SR/TB,${format},apad=whole_dur=${videoDuration}[amb];[2:a]${format},apad=pad_dur=0.5[s];[3:a]${format}[w];[amb][s][w]concat=n=3:v=0:a=1[a]`;
  const p = Bun.spawnSync([
    'ffmpeg',
    '-v',
    'error',
    '-y',
    '-i',
    video,
    ...ambient,
    '-i',
    sentence,
    '-i',
    word,
    '-filter_complex',
    filter,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libsvtav1',
    '-crf',
    '40',
    '-preset',
    '6',
    '-c:a',
    'libopus',
    '-b:a',
    '48k',
    '-movflags',
    '+faststart',
    output,
  ]);
  process.stderr.write(
    p.stderr
      .toString()
      .split('\n')
      .filter((line) => !line.startsWith('Svt[info]'))
      .join('\n'),
  );
  return p.exitCode;
}

if (import.meta.main) {
  try {
    process.exitCode = narrate(process.argv.slice(2));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
