/** Bounded, canonical PCM input; no files, URLs, codecs or browser decoder. */
export function decodeRecording(payload, { maxSeconds = 30 } = {}) {
  const invalid = () => { throw new Error('Record at most 30 seconds of mono 16 kHz WAV audio.'); };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).some(k => !['mimeType', 'dataBase64', 'language'].includes(k)) ||
      payload.mimeType !== 'audio/wav' || typeof payload.dataBase64 !== 'string' ||
      payload.dataBase64.length > 2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.dataBase64) ||
      (payload.language !== undefined && (typeof payload.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(payload.language)))) invalid();
  const data = Buffer.from(payload.dataBase64, 'base64');
  if (data.length < 44 || data.length > 2 * 1024 * 1024 || data.toString('base64') !== payload.dataBase64 ||
      data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE' || data.readUInt32LE(4) + 8 !== data.length) invalid();
  let offset = 12, format, pcm;
  while (offset + 8 <= data.length) {
    const name = data.toString('ascii', offset, offset + 4), length = data.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + length > data.length) invalid();
    if (name === 'fmt ') {
      if (format || length < 16) invalid();
      format = { codec: data.readUInt16LE(offset), channels: data.readUInt16LE(offset + 2), rate: data.readUInt32LE(offset + 4),
        byteRate: data.readUInt32LE(offset + 8), alignment: data.readUInt16LE(offset + 12), bits: data.readUInt16LE(offset + 14) };
    }
    if (name === 'data') { if (pcm) invalid(); pcm = data.subarray(offset, offset + length); }
    offset += length + length % 2;
  }
  if (offset !== data.length || !format || format.codec !== 1 || format.channels !== 1 || format.rate !== 16000 ||
      format.byteRate !== 32000 || format.alignment !== 2 || format.bits !== 16 || !pcm?.length || pcm.length % 2 || pcm.length > maxSeconds * 32000) invalid();
  const samples = new Float32Array(pcm.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return { samples, language: payload.language?.split('-')[0] };
}

export function pcmWave(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return { mimeType: 'audio/wav', dataBase64: Buffer.concat([header, pcm]).toString('base64') };
}
