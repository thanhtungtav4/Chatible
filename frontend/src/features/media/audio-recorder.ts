/**
 * Voice Audio Recorder with 30-Point Waveform Generator (T026)
 * Supports audio/webm;codecs=opus and audio/mp4 fallback.
 */

export interface AudioRecordingResult {
  blob: Blob;
  durationSeconds: number;
  waveform: number[]; // Array of 30 normalized amplitude points (0.0 - 1.0)
}

export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samplePoints: number[] = [];
  private sampleInterval: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('Trình duyệt không hỗ trợ ghi âm.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const AudioContextClass = window.AudioContext;
      if (!AudioContextClass) throw new Error('Trình duyệt không hỗ trợ Web Audio API.');

      this.mediaRecorder = recorder;
      this.audioChunks = [];
      this.samplePoints = [];
      this.startTime = Date.now();
      this.audioContext = new AudioContextClass();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;
      source.connect(this.analyser);

      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      this.sampleInterval = setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (const value of dataArray) sum += value;
        this.samplePoints.push(Math.min(1, Math.round((sum / dataArray.length / 255) * 100) / 100));
      }, 100);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.audioChunks.push(event.data);
      };
      recorder.start(200);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      await this.closeAudioContext();
      this.mediaRecorder = null;
      throw error;
    }
  }

  async stop(): Promise<AudioRecordingResult> {
    const { promise, resolve } = Promise.withResolvers<AudioRecordingResult>();

    if (this.sampleInterval) clearInterval(this.sampleInterval);
    this.sampleInterval = null;

    if (!this.mediaRecorder) {
      throw new Error('MediaRecorder chưa được khởi tạo.');
    }

    const durationSeconds = Math.max(1, Math.round((Date.now() - this.startTime) / 1000));

    this.mediaRecorder.onstop = () => {
      const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
      const audioBlob = new Blob(this.audioChunks, { type: mimeType });

      // Resample collected samplePoints into exactly 30 normalized points
      const waveform = this.normalizeWaveform(this.samplePoints, 30);

      // Stop mic tracks
      this.mediaRecorder?.stream.getTracks().forEach((track) => track.stop());
      if (this.audioContext && this.audioContext.state !== 'closed') {
        this.audioContext.close();
      }

      resolve({
        blob: audioBlob,
        durationSeconds,
        waveform,
      });
    };

    this.mediaRecorder.stop();
    return promise;
  }

  async cancel(): Promise<void> {
    const recorder = this.mediaRecorder;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.stop();
      });
    }
    recorder?.stream.getTracks().forEach((track) => track.stop());
    if (this.sampleInterval) clearInterval(this.sampleInterval);
    this.sampleInterval = null;
    this.mediaRecorder = null;
    await this.closeAudioContext();
  }

  private async closeAudioContext(): Promise<void> {
    const context = this.audioContext;
    this.audioContext = null;
    this.analyser = null;
    if (context && context.state !== 'closed') await context.close();
  }

  private normalizeWaveform(samples: number[], targetCount: number): number[] {
    if (samples.length === 0) {
      return Array(targetCount).fill(0.2);
    }

    const result: number[] = [];
    const step = samples.length / targetCount;

    for (let i = 0; i < targetCount; i++) {
      const index = Math.min(Math.floor(i * step), samples.length - 1);
      // Floor at 0.15 for attractive baseline waveform display
      result.push(Math.max(0.15, samples[index]));
    }

    return result;
  }
}
