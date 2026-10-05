const MAX_SECONDS=30;
const TARGET_RATE=16000;

export function wavFromPcm(chunks,sourceRate,targetRate=TARGET_RATE) {
  if(!Number.isFinite(sourceRate)||sourceRate<=0||!Number.isInteger(targetRate)||targetRate<=0)throw new RangeError('Invalid audio sample rate.');
  const count=chunks.reduce((sum,part)=>sum+part.length,0);
  if(!count || count>sourceRate*MAX_SECONDS)throw new RangeError('Recording must be between 0 and 30 seconds.');
  const joined=new Float32Array(count);let offset=0;
  for(const part of chunks){if(!(part instanceof Float32Array))throw new TypeError('PCM audio expected.');joined.set(part,offset);offset+=part.length;}
  const samples=Math.floor(count*targetRate/sourceRate);
  const bytes=new Uint8Array(44+samples*2);const view=new DataView(bytes.buffer);
  const write=(at,label)=>{for(let i=0;i<label.length;i++)view.setUint8(at+i,label.charCodeAt(i));};
  write(0,'RIFF');view.setUint32(4,36+samples*2,true);write(8,'WAVE');write(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,targetRate,true);view.setUint32(28,targetRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  write(36,'data');view.setUint32(40,samples*2,true);
  for(let i=0;i<samples;i++){
    const from=i*sourceRate/targetRate,to=Math.min(count,(i+1)*sourceRate/targetRate);
    let weighted=0;
    for(let j=Math.floor(from);j<Math.ceil(to);j++){
      const weight=Math.min(j+1,to)-Math.max(j,from);
      weighted+=(Number.isFinite(joined[j])?joined[j]:0)*weight;
    }
    const amplitude=Math.max(-1,Math.min(1,weighted/(to-from)));
    view.setInt16(44+i*2,amplitude<0?amplitude*32768:amplitude*32767,true);
  }
  if(bytes.length>2*1024*1024)throw new RangeError('Recording exceeded the audio size limit.');
  return bytes;
}

export function base64Bytes(bytes) {
  let value='';
  for(let i=0;i<bytes.length;i+=16384)value+=String.fromCharCode(...bytes.subarray(i,i+16384));
  return btoa(value);
}

/** A single utterance with pre-roll; silence after speech ends capture without a second click. */
export class UtteranceGate {
  constructor(sampleRate,{maximumSeconds=MAX_SECONDS,quietSeconds=2,minimumVoiceSeconds=.12}={}) {
    if(!Number.isFinite(sampleRate)||sampleRate<=0||sampleRate>192000)throw new RangeError('Invalid microphone rate.');
    this.sampleRate=sampleRate;this.maximumSamples=Math.floor(sampleRate*maximumSeconds);
    this.quietSeconds=quietSeconds;this.minimumVoiceSeconds=minimumVoiceSeconds;
    this.chunks=[];this.samples=0;this.voiceSeconds=0;this.quiet=0;this.noise=.002;this.heardVoice=false;
  }
  push(chunk) {
    if(!(chunk instanceof Float32Array)||!chunk.length)return {done:false,level:0};
    let sum=0;for(const sample of chunk)sum+=sample*sample;
    const rms=Math.sqrt(sum/chunk.length);const level=Math.min(1,rms*6);
    const voiced=rms>Math.max(.01,this.noise*3.2);
    if(!voiced && !this.heardVoice)this.noise=Math.min(.015,this.noise*.98+rms*.02);
    const duration=chunk.length/this.sampleRate;
    this.voiceSeconds=voiced?this.voiceSeconds+duration:0;
    if(this.voiceSeconds>=this.minimumVoiceSeconds)this.heardVoice=true;
    this.quiet=voiced?0:this.quiet+duration;
    const remaining=this.maximumSamples-this.samples;
    if(remaining>0){const copy=chunk.slice(0,remaining);this.chunks.push(copy);this.samples+=copy.length;}
    while(!this.heardVoice && this.samples>this.sampleRate*.3){const first=this.chunks.shift();this.samples-=first.length;first.fill(0);}
    const capped=this.samples>=this.maximumSamples;
    return {done:capped || (this.heardVoice && this.quiet>=this.quietSeconds),heardVoice:this.heardVoice,capped,level};
  }
  clear(){for(const chunk of this.chunks)chunk.fill(0);this.chunks=[];this.samples=0;}
}

export class VoiceCapture {
  constructor({onLevel=()=>{},onHeard=()=>{},onReady=()=>{}}={}) {this.onLevel=onLevel;this.onHeard=onHeard;this.onReady=onReady;this.session=null;}
  async start() {
    if(this.session)throw new Error('Microphone is already listening.');
    if(!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode)throw new Error('Microphone capture is unavailable here.');
    const session={stream:null,context:null,settled:false,gate:null,resolve:null,reject:null,startedAt:Date.now(),timer:null};
    session.promise=new Promise((resolve,reject)=>{session.resolve=resolve;session.reject=reject;});
    session.promise.catch(()=>{});
    this.session=session;
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(session.settled||this.session!==session){stream.getTracks().forEach(track=>track.stop());return session.promise;}
      session.stream=stream;
      const context=new AudioContext();session.context=context;
      await context.resume();
      if(session.settled)return session.promise;
      await context.audioWorklet.addModule(new URL('./voice-worklet.js',import.meta.url).href);
      if(session.settled)return session.promise;
      const input=context.createMediaStreamSource(stream),worklet=new AudioWorkletNode(context,'voice-capture'),silent=context.createGain();silent.gain.value=0;
      input.connect(worklet).connect(silent).connect(context.destination);
      session.gate=new UtteranceGate(context.sampleRate);
      worklet.port.onmessage=event=>{
        if(session.settled||this.session!==session)return;
        const sample=event.data;if(!(sample instanceof Float32Array))return;
        const wasHeard=session.gate.heardVoice;const result=session.gate.push(sample);
        this.onLevel(result.level);if(!wasHeard&&result.heardVoice)this.onHeard();
        if(result.done)this.stop(result.capped?'Recording reached its 30-second limit.':null);
      };
      session.timer=setTimeout(()=>this.stop('No speech was heard.'),MAX_SECONDS*1000);
      this.onReady();
      return session.promise;
    } catch(error){if(!session.settled){session.settled=true;session.reject(error);}await this.#close(session);return session.promise;}
  }
  stop(reason=null) {
    const session=this.session;if(!session||session.settled)return;
    session.settled=true;
    try {
      if(reason)throw new Error(reason);
      if(!session.gate?.heardVoice || session.gate.samples<session.gate.sampleRate*.12)throw new Error('No speech was heard.');
      const bytes=wavFromPcm(session.gate.chunks,session.gate.sampleRate);
      session.resolve({mimeType:'audio/wav',dataBase64:base64Bytes(bytes)});
    }catch(error){session.reject(error);}
    void this.#close(session);
  }
  cancel(){const session=this.session;if(!session||session.settled)return;session.settled=true;session.reject(new Error('Listening canceled.'));void this.#close(session);}
  async #close(session){clearTimeout(session.timer);session.stream?.getTracks().forEach(track=>track.stop());session.gate?.clear();await session.context?.close().catch(()=>{});if(this.session===session)this.session=null;this.onLevel(0);}
}
