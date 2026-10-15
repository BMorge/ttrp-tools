import { DIE_TYPES, type DieType } from '../dice/types';

import { renderDieClick, renderSurfaceKnock } from './presets';
import { VARIANTS, renderRoomImpulse } from './synth';
import { planImpact, planRattle, selectVoices, type SoundBatch, type Voice } from './voices';

import type { SoundSettings } from '../state';

const MAX_VOICES = 64;
/** Scheduling margin: knocks of a frame are spread over the frame time that follows. */
const LOOKAHEAD = 0.012;
/** An idle context is suspended to spare the CPU; the next roll (a click) resumes it. */
const IDLE_SUSPEND_MS = 4000;
/** Takes are rendered once, without an audio context; playback resamples them if the device runs at 44.1 kHz. */
const RENDER_RATE = 48_000;
/** Output level at full volume, before the limiter. */
const OUTPUT_GAIN = 1.3;

interface Banks {
  clicks: Map<DieType, AudioBuffer[]>;
  /** The tray as it answers each die type: that die's floor and rim. */
  surfaces: Map<DieType, { floor: AudioBuffer[]; wall: AudioBuffer[] }>;
  room: AudioBuffer;
}

interface Graph {
  context: AudioContext;
  /** Dry voices. */
  bus: GainNode;
  /** Reverb sends: every voice feeds it as much room as its die asks for. */
  roomBus: GainNode;
  master: GainNode;
  reverb: ConvolverNode;
}

type AudioContextConstructor = typeof AudioContext;

function toBuffer(...channels: Float32Array[]): AudioBuffer {
  const buffer = new AudioBuffer({ length: channels[0].length, numberOfChannels: channels.length, sampleRate: RENDER_RATE });
  channels.forEach((data, index) => buffer.getChannelData(index).set(data));
  return buffer;
}

function renderBanks(): Banks {
  const takes = (render: (variant: number) => Float32Array): AudioBuffer[] =>
    Array.from({ length: VARIANTS }, (_, variant) => toBuffer(render(variant)));
  const clicks = new Map<DieType, AudioBuffer[]>();
  const surfaces = new Map<DieType, { floor: AudioBuffer[]; wall: AudioBuffer[] }>();
  for (const type of DIE_TYPES) {
    clicks.set(type, takes((variant) => renderDieClick(type, variant, RENDER_RATE)));
    surfaces.set(type, {
      floor: takes((variant) => renderSurfaceKnock(type, 'floor', variant, RENDER_RATE)),
      wall: takes((variant) => renderSurfaceKnock(type, 'wall', variant, RENDER_RATE)),
    });
  }
  return { clicks, surfaces, room: toBuffer(...renderRoomImpulse(RENDER_RATE)) };
}

/**
 * Sound of the dice tray: only the knocks, nothing in between — a die resting or sliding on felt is
 * silent. Browsers start audio only after a user gesture inside this frame, so the context is created
 * by `unlock()` from a click or key handler. The takes (≈ 30–50 ms of synthesis) are prepared ahead
 * with `prepare()`, so the first click stays quick.
 */
export class DiceAudio {
  private graph: Graph | null = null;
  private banks: Banks | null = null;
  private settings: SoundSettings;
  private paused = false;
  private disposed = false;
  private activeVoices = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(settings: SoundSettings) {
    this.settings = { ...settings };
  }

  /** Renders the takes; cheap to call again. Call it when the browser is idle. */
  prepare(): void {
    if (this.banks || this.disposed || typeof AudioBuffer === 'undefined') {
      return;
    }
    this.banks = renderBanks();
    this.attach();
  }

  /** Creates or resumes audio. Call it synchronously inside a click or key handler. */
  unlock(): void {
    if (!this.settings.enabled || this.disposed) {
      return;
    }
    if (!this.graph) {
      this.graph = this.createGraph();
      this.attach();
      if (!this.banks) {
        setTimeout(() => this.prepare(), 0);
      }
    }
    const context = this.graph?.context;
    if (context && context.state !== 'running' && !this.paused) {
      void context.resume().catch(() => {});
    }
    this.scheduleIdle();
  }

  update(settings: SoundSettings): void {
    this.settings = { enabled: settings.enabled, volume: Math.min(1, Math.max(0, settings.volume)) };
    const graph = this.graph;
    if (graph) {
      graph.master.gain.setTargetAtTime(this.masterGain(), graph.context.currentTime, 0.03);
    }
  }

  /** A minimized window is silent; audio comes back with it (the frame already had a gesture). */
  setPaused(paused: boolean): void {
    this.paused = paused;
    const context = this.graph?.context;
    if (!context || context.state === 'closed') {
      return;
    }
    if (paused) {
      void context.suspend().catch(() => {});
    } else if (this.settings.enabled) {
      void context.resume().catch(() => {});
      this.scheduleIdle();
    }
  }

  /** Dice leaving the hand: a short rattle before they hit the tray. */
  throwStarted(types: readonly DieType[]): void {
    this.prepare();
    if (this.ready()) {
      this.start(planRattle(types, Math.random));
    }
  }

  /** The knocks of one animation frame. */
  play(batch: SoundBatch): void {
    if (!this.ready()) {
      return;
    }
    this.scheduleIdle();
    this.start(batch.impacts.flatMap((impact) => planImpact(impact, Math.random)));
  }

  /** One knock in the middle of the tray, so the volume can be judged while it is being set. */
  preview(): void {
    this.prepare();
    if (this.ready()) {
      this.start(planImpact({ type: 'd20', otherType: null, surface: 'floor', speed: 9, x: 0, z: 0, at: 0 }, Math.random));
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    void this.graph?.context.close().catch(() => {});
    this.graph = null;
    this.banks = null;
  }

  /** Voices may be scheduled on a context that is still resuming: they sound right after it starts. */
  private ready(): boolean {
    return Boolean(
      this.settings.enabled && !this.paused && !this.disposed && this.graph && this.banks
        && this.graph.context.state !== 'closed',
    );
  }

  /** The volume is perceived: the gain is its square. */
  private masterGain(): number {
    return this.settings.enabled ? OUTPUT_GAIN * this.settings.volume ** 2 : 0;
  }

  private createGraph(): Graph | null {
    const Context: AudioContextConstructor | undefined = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
    if (!Context) {
      return null;
    }
    const context = new Context({ latencyHint: 'interactive' });

    const bus = context.createGain();
    const roomBus = context.createGain();
    const reverb = context.createConvolver();
    // Warmth: a little more wood below, a little less glassy sheen on top.
    const body = context.createBiquadFilter();
    body.type = 'lowshelf';
    body.frequency.value = 250;
    body.gain.value = 3;
    const air = context.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 7000;
    air.gain.value = -4;
    const master = context.createGain();
    master.gain.value = this.masterGain();
    // Only a safety limiter at the very end: a low-threshold compressor lifts every quiet tail
    // (its make-up gain) and makes the background "breathe" after loud knocks.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    bus.connect(body);
    roomBus.connect(reverb).connect(body);
    body.connect(air).connect(master).connect(limiter).connect(context.destination);
    return { context, bus, roomBus, master, reverb };
  }

  /** Joins the takes and the graph once both exist: the room for the reverb. */
  private attach(): void {
    if (this.graph && this.banks && !this.graph.reverb.buffer) {
      this.graph.reverb.buffer = this.banks.room;
    }
  }

  private start(voices: Voice[]): void {
    const graph = this.graph;
    const banks = this.banks;
    if (!graph || !banks) {
      return;
    }
    const { context } = graph;
    const nyquist = context.sampleRate / 2 - 100;
    for (const voice of selectVoices(voices, MAX_VOICES - this.activeVoices)) {
      const buffer = voice.source.kind === 'click'
        ? banks.clicks.get(voice.source.type)?.[voice.variant]
        : banks.surfaces.get(voice.source.type)?.[voice.source.surface][voice.variant];
      if (!buffer) {
        continue;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = voice.playbackRate;
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = Math.min(voice.cutoff, nyquist);
      filter.Q.value = 0.5;
      const gain = context.createGain();
      gain.gain.value = voice.gain;
      const panner = context.createStereoPanner();
      panner.pan.value = voice.pan;
      const send = context.createGain();
      send.gain.value = voice.room;
      source.connect(filter).connect(gain).connect(panner).connect(graph.bus);
      panner.connect(send).connect(graph.roomBus);

      this.activeVoices += 1;
      source.onended = () => {
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
        panner.disconnect();
        send.disconnect();
        this.activeVoices -= 1;
      };
      source.start(context.currentTime + LOOKAHEAD + Math.max(0, voice.at));
    }
  }

  private scheduleIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const context = this.graph?.context;
      if (context && context.state === 'running' && this.activeVoices === 0 && !this.disposed) {
        void context.suspend().catch(() => {});
      }
    }, IDLE_SUSPEND_MS);
  }
}
