declare module 'standardized-audio-context' {
  export class OfflineAudioContext {
    constructor(channelCount: number, length: number, sampleRate: number);
    createBuffer(channelCount: number, length: number, sampleRate: number): any;
    createBufferSource(): any;
    createGain(): any;
    startRendering(): Promise<any>;
    readonly destination: any;
  }
}
