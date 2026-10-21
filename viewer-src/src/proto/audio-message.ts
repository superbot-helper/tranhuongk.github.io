// Port of UltraViewerProtocol/ComputerAudioMessage.swift.
// Host→viewer multipart 43 contains raw G.722 bytes; multipart 42 supplies an
// Int32LE count of zero PCM bytes. Silence does not advance G.722 state.

/** G722Decoder.maximumEncodedPacketBytes. */
export const MAX_ENCODED_PACKET_BYTES = 64 * 1024;
/** G722Decoder.maximumPCMPacketBytes: 4 PCM bytes per G.722 byte. */
export const MAX_PCM_PACKET_BYTES = MAX_ENCODED_PACKET_BYTES * 4;

export type AudioMessageErrorCode = 'malformedMessage' | 'unsupportedCommand' | 'packetTooLarge' | 'invalidSilenceLength';

export class AudioMessageError extends Error {
  readonly code: AudioMessageErrorCode;
  constructor(code: AudioMessageErrorCode) {
    super(code);
    this.name = 'AudioMessageError';
    this.code = code;
  }
}

export type AudioMessage = { type: 'g722'; data: Uint8Array } | { type: 'silence'; bytes: number };

/** Throws AudioMessageError (Swift `decode(parts:)`); never returns null. */
export function decodeAudioMessage(parts: Uint8Array[]): AudioMessage {
  const command = parts[0]?.[0];
  if (parts.length < 2 || command === undefined) throw new AudioMessageError('malformedMessage');
  let total = 0;
  for (const part of parts) {
    if (part.length > MAX_PCM_PACKET_BYTES - total) throw new AudioMessageError('packetTooLarge');
    total += part.length;
  }
  const body = parts[1]!;
  switch (command) {
    case 43:
      if (body.length > MAX_ENCODED_PACKET_BYTES) throw new AudioMessageError('packetTooLarge');
      return { type: 'g722', data: body };
    case 42: {
      if (body.length < 4) throw new AudioMessageError('malformedMessage');
      const count = body[0]! | (body[1]! << 8) | (body[2]! << 16) | (body[3]! << 24); // Int32 bit pattern
      if (count < 0 || count > MAX_PCM_PACKET_BYTES) throw new AudioMessageError('invalidSilenceLength');
      return { type: 'silence', bytes: count };
    }
    default:
      throw new AudioMessageError('unsupportedCommand');
  }
}
