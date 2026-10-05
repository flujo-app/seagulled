class VoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel=inputs[0]?.[0];
    if(channel?.length)this.port.postMessage(channel.slice());
    return true;
  }
}
registerProcessor('voice-capture',VoiceCaptureProcessor);
