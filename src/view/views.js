// The named views, and what each axis means on each machine.
//
// Pure data, and deliberately in its own file: the toolbar needs the list of
// views to build buttons from, and the toolbar must not pull three.js in with
// it. Everything here is numbers and strings; `view/axes.js` turns them into
// geometry and `view/viewport.js` points the camera with them.

/**
 * What each axis means on this machine.
 *
 * The letters do not change — the G-code says X, Y and Z whatever is in the
 * spindle — but what they *are* does, and that is the half a machinist needs
 * when the picture on screen has the part lying on its side.
 */
export const AXIS_MEANING = {
  mill: {
    x: 'X — table left/right',
    y: 'Y — table front/back',
    z: 'Z — spindle; up is away from the work',
  },
  // Two entries, not three. A lathe has no Y: the post refuses to write one,
  // the strategies never produce one, and an axis listed in the legend that
  // cannot appear in the program is a legend for a different machine.
  turn: {
    x: 'X — cross-slide, out from the spindle axis toward you (the G-code says diameter)',
    z: 'Z — along the bar, + toward the tailstock',
  },
};

/** Which axes a machine actually has. A lathe moves in two. */
export const AXES_OF = {
  mill: ['x', 'y', 'z'],
  turn: ['x', 'z'],
};

export function machineHasAxis(machine, axis) {
  return (AXES_OF[machine] ?? AXES_OF.mill).includes(axis);
}

/**
 * The standard views, as a direction to look *from* and which way is up.
 *
 * Named for what they show rather than for a compass point. `turning` is the
 * one the lathe opens on — Z running left to right along the bar, X up the
 * cross-slide — because that is how every lathe drawing in the world is laid
 * out, and showing a turned part in a mill's isometric is showing it wrong.
 *
 * `orbitUp` is the axis the camera orbits *about*. It defaults to `up`, and it
 * has to: the pole is what a horizontal drag swings the camera around, so a
 * pole that is not the axis drawn upward on screen transposes the mouse. The
 * lathe views used to name Z — the axis drawn *across* the screen — as their
 * pole, which is the reported bug exactly: dragging up and down rotated the
 * view horizontally and dragging sideways rolled the bar. See
 * viewport.setOrbitAxis, which is what installs it into OrbitControls.
 */
export const VIEW_PRESETS = {
  iso: { label: 'Iso', dir: [1, -1, 0.75], up: [0, 0, 1], hint: 'Isometric — the general view' },
  top: { label: 'Top', dir: [0, 0, 1], up: [0, 1, 0], hint: 'Looking down Z at the top face' },
  bottom: { label: 'Bottom', dir: [0, 0, -1], up: [0, -1, 0], hint: 'Looking up at the underside' },
  front: { label: 'Front', dir: [0, -1, 0], up: [0, 0, 1], hint: 'Looking along +Y at the front' },
  back: { label: 'Back', dir: [0, 1, 0], up: [0, 0, 1], hint: 'Looking along −Y at the back' },
  right: { label: 'Right', dir: [1, 0, 0], up: [0, 0, 1], hint: 'Looking along −X from the right' },
  left: { label: 'Left', dir: [-1, 0, 0], up: [0, 0, 1], hint: 'Looking along +X from the left' },

  // The other three isometrics. One iso shows you three faces of a part and
  // hides the other three, and the three it hides are frequently the ones with
  // the features on. Naming all four corners costs nothing and saves an orbit.
  isoFrontLeft: {
    label: 'Iso FL', dir: [-1, -1, 0.75], up: [0, 0, 1],
    hint: 'Isometric from the front-left corner',
  },
  isoBackRight: {
    label: 'Iso BR', dir: [1, 1, 0.75], up: [0, 0, 1],
    hint: 'Isometric from the back-right corner',
  },
  isoBackLeft: {
    label: 'Iso BL', dir: [-1, 1, 0.75], up: [0, 0, 1],
    hint: 'Isometric from the back-left corner',
  },
  isoUnder: {
    label: 'Iso under', dir: [1, -1, -0.75], up: [0, 0, 1],
    hint: 'Isometric from below — what a second-op setup has to reach',
  },

  // The lathe views put you where you stand at the machine: **the chuck on the
  // left**, Z growing to the right toward the tailstock, and X — the
  // cross-slide — coming out of the screen at you, because that is where it
  // goes on a front-toolpost lathe. Winding the cross-slide toward yourself
  // takes the tool to a bigger diameter, and the picture should say so.
  //
  // These used to draw X *up* the screen: the ZX plane seen face-on, which is
  // how a lathe is drawn on paper and is not how one looks. The tool appeared
  // to come down onto the top of the bar like a mill, and the axis a machinist
  // reaches for with their right hand was the vertical one.
  //
  // Screen-up is −Y, and that is not an oversight. Fixing two of the three
  // fixes the third: with Z to the right and X toward the viewer, a
  // right-handed frame has no choice about the last one, and Z × X points down.
  // It is the same quirk that makes a front-toolpost lathe's unused Y axis
  // point at the floor — the machine is the thing that is left-handed about it,
  // and the picture agrees with the machine.
  turning: {
    label: 'Side',
    dir: [1, 0, 0],
    up: [0, -1, 0],
    hint: 'Standing at the machine: the chuck on the left, Z along the bar to '
      + 'the right, X out of the screen toward you',
  },
  turningIso: {
    label: 'Iso',
    dir: [1, -0.4, 0.35],
    up: [0, -1, 0],
    hint: 'The bar from the operator\'s side, a little above',
  },
  chuck: {
    label: 'End',
    dir: [0, 0, 1],
    up: [0, -1, 0],
    hint: 'Down the spindle axis at the free end of the bar, the front of the '
      + 'machine on the left',
  },
  turningBack: {
    label: 'Back',
    dir: [-1, 0, 0],
    up: [0, -1, 0],
    hint: 'From behind the machine — where a rear parting blade works. The bar '
      + 'runs the other way, because you are on the other side of it',
  },
  turningPlan: {
    label: 'Plan',
    dir: [0, -1, 0],
    up: [-1, 0, 0],
    hint: 'Looking down on the machine from above, your side of it nearest — '
      + 'the plane the tool works in, seen flat',
  },
  tailstock: {
    label: 'Tail',
    dir: [0, 0, -1],
    up: [0, -1, 0],
    hint: 'From the chuck end, looking toward the tailstock',
  },
};

/**
 * Views that are square on to a plane — the ones worth seeing in orthographic.
 *
 * A face view is asked for in order to *compare* things: two diameters at
 * opposite ends of a bar, a shoulder against a shoulder. Perspective makes the
 * far one smaller, which is the one property that ruins the comparison, so
 * picking one of these switches the projection and orbiting away switches it
 * back. See app/actions/editing.js setView.
 */
export const SQUARE_ON_VIEWS = new Set([
  'top', 'bottom', 'front', 'back', 'right', 'left',
  'turning', 'turningBack', 'turningPlan', 'chuck', 'tailstock',
]);

/**
 * Which views a machine offers on the toolbar, in the order they belong on it.
 *
 * A lathe gets three, and not the mill's six: four of those are faces of a box
 * that a turned part does not have, and the mill's isometric puts Z up, which
 * stands the bar on end. Offering them anyway would mean two buttons on the bar
 * labelled "Iso" that do different things.
 */
export function viewsFor(machine) {
  return machine === 'turn'
    // Plan earns a place on the bar now that Side is a view *of the machine*:
    // the toolpath lives entirely in the ZX plane, and looking down on it from
    // above is the one view that shows the whole of it flat rather than
    // edge-on. It used to be what Side did, so it must not be behind a caret.
    ? ['turning', 'turningIso', 'turningPlan', 'chuck']
    : ['iso', 'top', 'front', 'right', 'back', 'left', 'bottom'];
}

/**
 * The rest of them, for the overflow menu.
 *
 * A toolbar with eleven view buttons on it is not a toolbar, it is a keypad —
 * so the ones you reach for daily stay on the bar and the ones you reach for
 * occasionally live one click behind a caret.
 */
export function extraViewsFor(machine) {
  return machine === 'turn'
    ? ['turningBack', 'tailstock']
    : ['isoFrontLeft', 'isoBackRight', 'isoBackLeft', 'isoUnder'];
}

/** Every view a machine offers, toolbar and menu together. */
export function allViewsFor(machine) {
  return [...viewsFor(machine), ...extraViewsFor(machine)];
}

/**
 * The view a machine opens on.
 *
 * A lathe opens on **Plan**, not on its isometric, and for the same reason the
 * mill does not open on Top: the view you want first is the one that shows the
 * work you are about to do. A turned part's toolpath lives entirely in the ZX
 * plane, and Plan is the only view that shows the whole of it flat — every
 * other lathe view sees that plane edge-on or foreshortened, so a profile that
 * is out by a millimetre looks fine until you orbit. The isometric is a
 * prettier picture of a bar and a worse drawing of a toolpath.
 *
 * Plan is also square-on, so opening on it opens orthographic (see
 * SQUARE_ON_VIEWS), which is what makes two diameters at opposite ends of the
 * bar comparable on screen.
 */
export function defaultViewFor(machine) {
  return machine === 'turn' ? 'turningPlan' : 'iso';
}

/**
 * Which way the camera orbits about for a view: the axis drawn upward on screen.
 *
 * A preset may still override it, but nothing does — an orbit pole that is not
 * screen-up swaps what the two mouse axes do, and there is no view where that is
 * what anybody wants.
 */
export function orbitUpOf(preset) {
  return preset?.orbitUp ?? preset?.up ?? [0, 0, 1];
}

/**
 * How a scene is projected onto the screen.
 *
 * Perspective is what a part looks like. Orthographic is what a part *is*:
 * parallel edges stay parallel, so two diameters at opposite ends of a bar are
 * comparable on screen and a face that is square reads as square. Every CAD
 * package has both for that reason, and measuring anything off a perspective
 * view is measuring the distance to the camera as much as the part.
 */
export const PROJECTIONS = ['auto', 'perspective', 'orthographic'];

export const PROJECTION_LABELS = {
  auto: 'Automatic',
  perspective: 'Perspective',
  orthographic: 'Orthographic',
};

export const PROJECTION_HINTS = {
  auto: 'Orthographic square on, perspective everywhere else — the projection '
    + 'follows what the view is for',
  perspective: 'Depth reads naturally; far things are smaller',
  orthographic: 'Parallel edges stay parallel — sizes are comparable anywhere '
    + 'on screen, which is what you want for checking a profile',
};
