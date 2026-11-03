// Breeze streams headerless PCM; every consumer of `tts` expects a WAV file.

/** Wrap mono 16-bit little-endian PCM in a canonical 44-byte RIFF header. */
export function wav(pcm: ArrayBuffer, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const tag = (offset: number, text: string) => out.set(Buffer.from(text, 'ascii'), offset);
  tag(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  tag(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  out.set(new Uint8Array(pcm), 44);
  return out;
}
