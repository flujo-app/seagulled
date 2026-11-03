// Independent holds prevent a completed transition from hiding an active auth check.
export class LoadingScreen {
  constructor({stage,video,fadeMs=180,pulseMs=800}) {
    this.stage=stage;this.video=video;this.fadeMs=fadeMs;this.pulseMs=pulseMs;
    this.holds=new Set();this.pulseRelease=null;this.destroyed=false;
    this.startupRelease=this.hold();
  }
  hold() {
    if(this.destroyed)return()=>{};
    const ticket=Symbol();this.holds.add(ticket);this.render();
    return()=>{if(this.holds.delete(ticket))this.render();};
  }
  async during(operation) {
    const release=this.hold();try{return await operation();}finally{release();}
  }
  pulse() {
    if(this.destroyed)return;
    const release=this.hold();clearTimeout(this.pulseTimer);this.pulseRelease?.();
    this.pulseRelease=release;
    this.pulseTimer=setTimeout(()=>{release();this.pulseRelease=null;},this.pulseMs);
  }
  ready() {this.startupRelease();}
  render() {
    const active=this.holds.size>0;this.stage.dataset.loading=String(active);
    clearTimeout(this.pauseTimer);
    if(active){this.video.muted=true;void this.video.play().catch(()=>{});}
    else this.pauseTimer=setTimeout(()=>{if(!this.holds.size)this.video.pause();},this.fadeMs);
  }
  destroy() {
    this.destroyed=true;clearTimeout(this.pauseTimer);clearTimeout(this.pulseTimer);
    this.holds.clear();this.video.pause();
  }
}
