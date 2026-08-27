// Simulation transport: scrub, play/pause, step, speed.
//
// **The slider is in milliseconds, and so is everything drawn under it.**
//
// It used to be indexed by move, on the argument that moves are what the
// simulator logs against and seeking by index is exact and cheap. Both true, and
// it made the transport disagree with itself: the operation bands beneath the
// slider are laid out in *time*, because a hundred-step facing pass and a
// hundred-step drill cycle are not the same width of anybody's attention. Two
// units along one axis is two rulers on one edge — the thumb sat over the wrong
// band, clicking a band put the thumb somewhere else, and the further into a
// program with any variety in it, the wider the gap. Steps are still what the
// simulation is *seeked* to; the transport just no longer measures in them.
//
// The step buttons are the one thing that is still a step: ◀ and ▶| move one
// move, and read the clock's own cursor to know where they are.
//
// Playback advances on wall-clock time scaled by the speed multiplier, so
// changing speed does not change what you see, only how fast it arrives.
//
// The playhead is held in seconds and advanced continuously, *not* re-read from
// whatever step it currently maps to. Steps are coarse in time — a single
// plunge can be three seconds long — so rounding the playhead onto a step each
// frame would snap it back to the start of that step and it would never leave.

import { el } from './layout.js';
import { PlaybackClock } from '../engine/simulate.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 10, 50];

export function buildTimeline(onSeek, onClose) {
  let stepCount = 0;
  let playing = false;
  let speed = 4;
  let lastFrame = 0;
  let clock_ = null;       // PlaybackClock; seconds are the authority
  let totalSeconds = 0;
  let bands = [];          // { name, from, to, step } per operation, in seconds

  const slider = el('input', { type: 'range', min: '0', max: '0', value: '0', step: '1' });
  const playButton = el('button', { class: 'sim-play', title: 'Play / pause' }, ['▶']);
  const timeLabel = el('span', { class: 'sim-time' }, ['0:00 / 0:00']);
  const speedSelect = el('select', { title: 'Playback speed' },
    SPEEDS.map((s) => el('option', { value: String(s) }, [`${s}×`])));
  speedSelect.value = String(speed);

  /** Put the slider where the clock is. Milliseconds, so the range is integral. */
  const syncSlider = () => {
    slider.value = String(Math.round((clock_?.seconds ?? 0) * 1000));
  };

  /** Show a moment: what scrubbing, the bands and "back to start" all mean. */
  const seekSeconds = (seconds) => {
    if (!clock_) return;
    const at = Math.max(0, Math.min(seconds, totalSeconds));
    clock_.seconds = at;
    const step = clock_.stepAt(at);
    syncSlider();
    onSeek(step, at);
    render();
  };

  /** Show a move: what the step buttons mean, and nothing else. */
  const seekStep = (step) => {
    if (!clock_) return;
    const landed = clock_.toStep(step);
    syncSlider();
    onSeek(landed, clock_.seconds);
    render();
  };

  const render = () => {
    const at = Math.min(clock_?.seconds ?? 0, totalSeconds);
    timeLabel.textContent = `${formatClock(at)} / ${formatClock(totalSeconds)}`;
    playButton.textContent = playing ? '❚❚' : '▶';
    playButton.classList.toggle('playing', playing);
    // which band the playhead is in — by time, since that is what it holds
    const inside = bands.findIndex((b) => at >= b.from - 1e-9 && at < b.to);
    const active = inside < 0 && bands.length ? bands.length - 1 : inside;
    currentLabel.textContent = active >= 0 ? bands[active].name : '';
    [...bandStrip.children].forEach((node, i) => {
      node.classList.toggle('active', i === active);
    });
  };

  const setPlaying = (next) => {
    playing = next;
    if (playing) {
      // restarting from the end replays rather than sitting stuck at the tail
      if (clock_?.finished) seekSeconds(0);
      lastFrame = performance.now();
      requestAnimationFrame(tick);
    }
    render();
  };

  function tick(now) {
    if (!playing) return;
    const dt = Math.min((now - lastFrame) / 1000, 0.25); // ignore tab-away gaps
    lastFrame = now;

    const step = clock_.advance(dt * speed);
    syncSlider();
    onSeek(step, clock_.seconds);
    render();

    if (clock_.finished) setPlaying(false);
    else requestAnimationFrame(tick);
  }

  slider.addEventListener('input', () => {
    if (playing) setPlaying(false);
    seekSeconds(Number(slider.value) / 1000);
  });
  playButton.addEventListener('click', () => setPlaying(!playing));
  speedSelect.addEventListener('change', () => { speed = Number(speedSelect.value); });

  // `clock_.cursor` is the move the playhead is on, whether it got there by
  // scrubbing or by playing — which is what makes "one more move" mean the same
  // thing after either.
  const jump = (delta) => {
    if (playing) setPlaying(false);
    seekStep((clock_?.cursor ?? 0) + delta);
  };

  /**
   * Which operation the playhead is in, drawn under the slider.
   *
   * A scrub bar with one continuous track says how far through the *program*
   * you are and nothing about what is being cut. That is the one thing you
   * actually want while watching: "why is it there" is almost always answered
   * by which operation is running. The bands are proportional to time, and so
   * is the slider above them — a hundred-step facing pass and a hundred-step
   * drill cycle are not the same width of anybody's attention, and two rulers on
   * one edge is the bug at the top of this file.
   */
  const bandStrip = el('div', { class: 'sim-bands' });
  const currentLabel = el('span', { class: 'sim-op' }, ['']);
  // the heaviest moment in the program — see drawLoad
  const loadLabel = el('button', { class: 'sim-load' }, []);
  // and whether what it leaves behind is the part — see drawVerify
  const verifyLabel = el('button', { class: 'sim-verify' }, []);

  const drawBands = (sim, ops) => {
    bandStrip.replaceChildren();
    bands = [];
    if (!ops?.length || !(sim.totalSeconds > 0)) return;
    let step = 0;
    let from = 0;
    ops.forEach(({ name, cl }, i) => {
      // Captured per band, not read from the loop variables. `step` and `from`
      // are mutated on the way round, and a handler that closes over them sees
      // the *last* values — so every band seeked to the end of the program,
      // which looks exactly like a scrub bar that ignores where you clicked.
      const startStep = step;
      const startAt = from;
      // Where the operation ends is the *simulator's* answer, not `cl.count`.
      // A turning run subdivides every move into pieces, so its steps outnumber
      // its moves several-fold; counting moves here walked a fraction of the
      // way along `times` and every band came out a fraction of its true width,
      // leaving the strip stopping short of the end of the slider. A run that
      // hit the record limit stops early for the same reason. See engine
      // simulate.js `opEnds`.
      const end = sim.opEnds?.[i] ?? step + cl.count;
      // times[k] is when step k finishes, so the operation ends when its last
      // step does; the array is one longer than the step count
      const to = Math.min(sim.times[Math.min(end, sim.times.length - 1)] ?? sim.totalSeconds,
        sim.totalSeconds);
      step = end;
      from = to;
      // An operation that takes no machine time gets no band. It cannot be
      // given one: a band is a stretch of the track, `min-width` gives the
      // shortest of them two pixels of it anyway, and two pixels standing for
      // zero seconds is a place on the ruler that answers to no time at all —
      // click it and the playhead lands in the operation before. A drill that
      // matched no hole is not a sliver of the program, it is none of it.
      if (!(to - startAt > 0)) return;
      bands.push({ name, from: startAt, to, step: startStep });
      const width = ((to - startAt) / sim.totalSeconds) * 100;
      bandStrip.append(el('div', {
        // Grown in proportion rather than sized in percent. Percent widths are
        // shrinkable and never quite add up — rounding, a min-width on a short
        // operation, a run that recorded less than the whole program — and the
        // strip ended a visible slice short of the slider it labels. Growth
        // shares out whatever the track actually is, so it always fills it.
        class: `sim-band sim-band-${i % 4}`,
        style: `flex:${Math.max(width, 0).toFixed(4)} 0 0%`,
        title: `${name} — ${formatClock(to - startAt)}`,
        onclick: () => { if (playing) setPlaying(false); seekSeconds(startAt); },
      }, [name]));
    });
  };

  /**
   * The heaviest moment in the program, and a way to go and look at it.
   *
   * The simulation's answer used to be a shape, and a shape cannot show this: a
   * pass that takes a tenth of a millimetre and one that takes the whole
   * diameter leave the same floor behind. The numbers come off the same sweep
   * that carves the billet — see engine/simulate.js LoadLog — so this is not a
   * second opinion about the program, it is the one the picture is already
   * made of.
   */
  const drawLoad = (sim, ops) => {
    const load = sim?.load;
    if (!load || !(load.peakWidth > 0 || load.peakDepth > 0)) {
      loadLabel.replaceChildren();
      loadLabel.className = 'sim-load';
      loadLabel.onclick = null;
      loadLabel.title = '';
      return;
    }
    // A lathe reports the depth of cut alone: its tool is a corner rather than
    // a disc, so there is no radial width to hold anything to. See LoadLog in
    // engine/simulate.js.
    const lathe = !(load.peakWidth > 0);
    const heavy = load.peakWidth > 0.9;
    const where = ops[lathe ? load.peakDepthOp : load.peakWidthOp]?.name;
    const deep = load.peakDepth > 0 ? `${load.peakDepth.toFixed(1)}mm deep` : '';
    loadLabel.className = `sim-load${heavy ? ' warn' : ''}`;
    loadLabel.replaceChildren(lathe ? deep
      : `${load.peakWidth.toFixed(2)}×D${deep ? ` at ${deep}` : ''}`);
    const share = load.cutting > 0 ? (load.buried / load.cutting) * 100 : 0;
    loadLabel.title = lathe
      ? `Deepest cut the insert takes: ${deep}${where ? `, in ${where}` : ''}. `
        + 'Click to go there. Plunges — grooving, parting, drilling — are full depth '
        + 'by nature and are not counted; the peck governs those.'
      : `Widest bite the cutter takes: ${load.peakWidth.toFixed(2)} of its own `
        + `diameter${where ? `, in ${where}` : ''}${deep ? ` at ${deep}` : ''}. `
        + `${load.buried.toFixed(0)}mm of the ${(load.cutting / 1000).toFixed(1)}m it cuts `
        + `(${share.toFixed(1)}%) is taken at more than three quarters of its width. `
        + 'Click to go there. Entries — plunges, ramps, the circle a seeded peel bores — '
        + 'are full width by nature and are not counted; the ramp angle governs those.';
    loadLabel.onclick = () => {
      const step = load.peakDepthAt >= 0 ? load.peakDepthAt : load.peakWidthAt;
      if (step < 0 || !sim.times) return;
      if (playing) setPlaying(false);
      seekSeconds(sim.times[Math.min(step, sim.times.length - 1)] ?? 0);
    };
  };

  /**
   * The verdict on the finished part, in the two numbers that matter.
   *
   * A gouge wins whenever there is one, because the two are not comparable:
   * excess is another pass and a gouge is a new billet. Clicking goes to the
   * moment it happened, which is the whole reason the event log records which
   * step took each cell down — see engine/verify.js lastTouch.
   */
  const drawVerify = (sim, ops) => {
    const v = sim?.verify;
    verifyLabel.className = 'sim-verify';
    verifyLabel.onclick = null;
    if (!v) {
      verifyLabel.replaceChildren();
      verifyLabel.title = '';
      return;
    }
    const tol = v.tolerance.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    // A share of the part rather than a count of cells: how many grid cells
    // there are is a detail setting, and a number that moves when you change
    // the picture quality says nothing about the program.
    const share = (n) => `${((n / Math.max(v.checked, 1)) * 100).toFixed(
      n > 0 && n * 1000 < v.checked ? 2 : 0)}%`;
    const worst = v.worstGouge ?? v.worstExcess;
    const gouged = !!v.worstGouge;
    if (!worst) {
      verifyLabel.className = 'sim-verify ok';
      verifyLabel.replaceChildren(`✓ ±${tol}mm`);
      verifyLabel.title = `The finished surface is within ${tol}mm of the model `
        + 'everywhere the part is. Green on the stock is the part, blue is metal '
        + 'still standing on it, red is metal cut out of it.';
      return;
    }
    const where = ops[worst.op]?.name;
    verifyLabel.className = `sim-verify ${gouged ? 'bad' : 'left'}`;
    verifyLabel.replaceChildren(gouged
      ? `gouge ${worst.mm.toFixed(2)}mm`
      : `${worst.mm.toFixed(2)}mm left`);
    verifyLabel.title = gouged
      ? `The program cuts ${worst.mm.toFixed(3)}mm into the part at `
        + `X${worst.x.toFixed(1)} Y${worst.y.toFixed(1)}${where ? `, in ${where}` : ''}. `
        + `${share(v.gougeCells)} of the part is past the ${tol}mm tolerance. `
        + 'Nothing later can put that metal back. Click to go to the move that took it.'
      : `${worst.mm.toFixed(3)}mm of stock is still standing on the part at `
        + `X${worst.x.toFixed(1)} Y${worst.y.toFixed(1)}, and no operation in any setup `
        + `takes it off. ${share(v.excessCells)} of the part is over the ${tol}mm `
        + 'tolerance. Click to go there.';
    verifyLabel.onclick = () => {
      if (!(worst.step >= 0) || !sim.times) return;
      if (playing) setPlaying(false);
      seekSeconds(sim.times[Math.min(worst.step, sim.times.length - 1)] ?? 0);
    };
  };

  const root = el('div', { id: 'sim', class: 'collapsed' }, [
    el('span', { class: 'sim-label' }, ['Simulation']),
    el('button', { title: 'Back to start', onclick: () => jump(-Infinity) }, ['⏮']),
    el('button', { title: 'Step back', onclick: () => jump(-1) }, ['◀']),
    playButton,
    el('button', { title: 'Step forward', onclick: () => jump(1) }, ['▶|']),
    el('button', { title: 'Jump to end', onclick: () => jump(Infinity) }, ['⏭']),
    speedSelect,
    el('div', { class: 'sim-track' }, [slider, bandStrip]),
    currentLabel,
    loadLabel,
    verifyLabel,
    timeLabel,
    el('button', { class: 'sim-close', title: 'Close simulation', onclick: () => { setPlaying(false); onClose(); } }, ['✕']),
  ]);

  return {
    root,
    show(sim, ops = []) {
      stepCount = sim.stepCount;
      totalSeconds = sim.totalSeconds;
      clock_ = new PlaybackClock(sim.times, stepCount);
      slider.max = String(Math.max(1, Math.round(totalSeconds * 1000)));
      drawBands(sim, ops);
      drawLoad(sim, ops);
      drawVerify(sim, ops);
      root.classList.remove('collapsed');
      seekSeconds(0);
    },
    hide() {
      setPlaying(false);
      root.classList.add('collapsed');
    },
    get visible() { return !root.classList.contains('collapsed'); },
  };
}

function formatClock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
