// Preferences: the choices that belong to the person rather than to the job.
//
// The distinction matters and it is why these do not live in the project. How
// finely the simulation is gridded, whether rapids are drawn, whether the grid
// is on — none of that changes the part, travels with the file, or belongs in
// anybody's undo stack. It is how *you* like to look at a job, so it is kept in
// this browser and applied to whatever is open.
//
// The counter-example is in the project on purpose: the machine's rapid rate is
// a fact about the machine, so it lives on the machine record (doc/machines.js)
// and travels with the file.
//
// Every setting here has to *do* something. A preferences dialog full of
// switches that are read once at boot and never again is a dialog that lies, so
// each one names the thing it changes and `applySettings` in main.js is the one
// place that pushes them into the viewport.

import { PATH_COLORS } from '../view/path-colors.js';

const KEY = 'cncam.settings';

/**
 * @typedef {{ key, label, type, group, hint, options?, labels?, min?, max?, step? }} Setting
 */
// Library last: it is the only group whose rows *do* something rather than
// being a preference that is read back later.
/** What moves on screen when the tool leans — see view/viewport.js machineView. */
export const TILT_DISPLAYS = ['tool', 'part', 'both'];
export const TILT_DISPLAY_LABELS = {
  tool: 'The cutter — the part stays put (head-head)',
  part: 'The part — the cutter stays upright (table-table)',
  both: 'Both — the cutter leans, the part turns (head-table)',
};

export const SETTING_GROUPS = ['Appearance', 'Viewport', 'Simulation', 'Editing', 'Experimental', 'Library'];

export const SETTINGS = [
  // --- experimental ---
  {
    key: 'fiveAxisBeta',
    label: '5-axis milling (beta)',
    group: 'Experimental',
    type: 'checkbox',
    default: false,
    hint: 'Simultaneous 5-axis surface finishing on a table-table trunnion '
      + '(A/C or B/C), with the tool-axis simulation, crash and engagement '
      + 'checks and the 5-axis setup assistant that go with it. A beta: the '
      + 'simulation sees only the top of the part (no undercuts), the post has '
      + 'not met your machine, and a mirrored A or C is one jog test away. Dry-run '
      + 'every program in the air before it touches metal. Operations already in '
      + 'a project stay in it with this off; they just cannot be generated.',
  },

  // --- library ---
  {
    key: 'resetToolLibrary',
    label: 'Tool library',
    group: 'Library',
    type: 'action',
    button: 'Reset to the built-in tools…',
    hint: 'Deletes every catalogue you have made or imported in this browser, '
      + 'along with any photographs on those cutters, and leaves the built-in '
      + 'presets — which are the same in every browser and cannot be edited '
      + 'away. Tools already in a project are not touched: a project keeps its '
      + 'own copy. There is no undo, so export a catalogue you might want back.',
  },

  {
    key: 'toolPickerView',
    label: 'Tool library layout',
    group: 'Library',
    type: 'select',
    options: ['grid', 'list'],
    labels: { grid: 'Cards — big drawings', list: 'List — rows, with a full preview beside them' },
    default: 'grid',
    hint: 'How the picker opens. Cards give the drawing the room; the list is '
      + 'denser, and shows the whole tool — flutes, shank, holder — for the row '
      + 'under the pointer. The toggle in the picker changes this too.',
  },
  {
    key: 'toolPickerSort',
    label: 'Tool library order',
    group: 'Library',
    type: 'select',
    options: ['catalogue', 'name', 'diameter', 'type', 'recent'],
    labels: {
      catalogue: 'As the catalogue lists them', name: 'By name', diameter: 'By diameter',
      type: 'By kind of tool', recent: 'Most recently used first',
    },
    default: 'catalogue',
    hint: 'The order of tools inside each group of the picker. Favourites (the '
      + 'star on a card) always come first within a group.',
  },
  {
    key: 'toolPreviewStyle',
    label: 'Tool drawing style',
    group: 'Library',
    type: 'select',
    options: ['shaded', 'flat', 'outline'],
    labels: {
      shaded: 'Shaded — lit like metal', flat: 'Flat — solid colour', outline: 'Outline — drafting line',
    },
    default: 'shaded',
    hint: 'How every cutter drawing in the app is painted: the tree, the picker, '
      + 'the builder and the properties panel. Outline suits a screenshot for a '
      + 'setup sheet; flat reads best on a small screen.',
  },
  {
    key: 'toolCallouts',
    label: 'Dimension callouts on the tool preview',
    group: 'Library',
    type: 'checkbox',
    default: true,
    hint: 'Draws diameter, flute length, stickout, overall length, corner radius '
      + 'and point angle on the large preview in the builder and the library, '
      + 'measured from the same geometry the simulation uses.',
  },

  // --- appearance ---
  //
  // The look of the window around the part. All of it is applied by
  // app/appearance.js, from one place, as CSS variables on the document — a
  // theme is a block of variables in styles.css and nothing else.
  {
    key: 'uiTheme',
    label: 'Colour scheme',
    group: 'Appearance',
    type: 'select',
    options: ['graphite', 'midnight', 'light', 'contrast'],
    labels: {
      graphite: 'Graphite — neutral dark',
      midnight: 'Midnight — blue-black',
      light: 'Light — for a bright shop floor',
      contrast: 'High contrast — black and white edges',
    },
    default: 'graphite',
    hint: 'The panels, dialogs and text. The part and the toolpaths keep their '
      + 'own colours, so a path reads the same in every scheme.',
  },
  {
    key: 'uiAccent',
    label: 'Accent colour',
    group: 'Appearance',
    type: 'select',
    options: ['steel', 'teal', 'green', 'amber', 'violet', 'rose'],
    labels: {
      steel: 'Steel blue', teal: 'Teal', green: 'Green', amber: 'Amber', violet: 'Violet', rose: 'Rose',
    },
    default: 'steel',
    hint: 'What is selected, and the button that is the next thing to press. '
      + 'Warnings stay amber and errors red whatever this is set to: those '
      + 'colours say what the message is.',
  },
  {
    key: 'uiScale',
    label: 'Interface size',
    group: 'Appearance',
    type: 'select',
    options: ['90', '100', '110', '125'],
    labels: {
      90: 'Compact — 90%', 100: 'Standard', 110: 'Comfortable — 110%', 125: 'Large — 125%',
    },
    default: '100',
    hint: 'Scales the toolbar, the tree, the property panel, the status line and '
      + 'dialogs together. The 3D view is not scaled — it takes whatever room '
      + 'the panels leave.',
  },
  {
    key: 'viewBackground',
    label: 'Viewport background',
    group: 'Appearance',
    type: 'select',
    options: ['gradient', 'flat', 'black', 'blueprint', 'paper', 'custom'],
    labels: {
      gradient: 'Graphite gradient',
      flat: 'Flat dark grey',
      black: 'Black',
      blueprint: 'Blueprint blue',
      paper: 'Paper white',
      custom: 'Custom colour (below)',
    },
    default: 'gradient',
    hint: 'What the part stands in front of. A light backdrop shows a dark '
      + 'part and dark paths better; a dark one is easier on the eyes in a '
      + 'dim shop.',
  },
  {
    key: 'viewBackgroundColor',
    label: 'Custom background colour',
    group: 'Appearance',
    type: 'color',
    default: '#2a3140',
    hint: 'Used when the background above is Custom. The top and bottom of the '
      + 'viewport are this colour a little lighter and a little darker.',
  },
  {
    key: 'resetLayout',
    label: 'Panel layout',
    group: 'Appearance',
    type: 'action',
    safe: true,
    button: 'Reset panel sizes',
    hint: 'Puts the tree, property panel and G-code console back to their '
      + 'default sizes and unfolds the checklist. Drag a splitter to set a size; '
      + 'double-click one to reset just that panel.',
  },

  // --- viewport ---
  {
    key: 'projection',
    label: 'Projection',
    group: 'Viewport',
    type: 'select',
    options: ['auto', 'perspective', 'orthographic'],
    labels: {
      auto: 'Automatic — square-on views are orthographic',
      perspective: 'Perspective',
      orthographic: 'Orthographic',
    },
    default: 'auto',
    hint: 'Orthographic keeps parallel edges parallel, so two diameters at '
      + 'opposite ends of a bar are the same size on screen and can be compared. '
      + 'It is the projection to check a profile in. Automatic switches to it '
      + 'for Front, Top and the other square-on views and back on the first '
      + 'orbit — and says which one you are in, rather than switching the camera '
      + 'behind the setting.',
  },
  {
    key: 'showGrid',
    label: 'Table grid',
    group: 'Viewport',
    type: 'checkbox',
    default: true,
    hint: 'Squares in round millimetres, so counting three of them to judge a '
      + 'clearance means something. A lathe never shows one — there is no table.',
  },
  {
    key: 'showAxes',
    label: 'Axis arrows at zero',
    group: 'Viewport',
    type: 'checkbox',
    default: true,
  },
  {
    key: 'showTriad',
    label: 'Orientation triad in the corner',
    group: 'Viewport',
    type: 'checkbox',
    default: true,
    hint: 'The world axes sit at the machine origin, which is usually under the '
      + 'part and often off screen. This one always is not.',
  },
  {
    key: 'showRapids',
    label: 'Draw rapid moves',
    group: 'Viewport',
    type: 'checkbox',
    default: true,
    hint: 'The orange lines. Turning them off leaves only metal being cut, '
      + 'which is what you want when checking a path and not its linking.',
  },
  {
    key: 'pathBrightness',
    label: 'Toolpath brightness',
    group: 'Viewport',
    type: 'select',
    options: ['dim', 'normal', 'bright'],
    labels: { dim: 'Dim', normal: 'Normal', bright: 'Bright' },
    default: 'normal',
    hint: 'Eleven overlapping paths in one colour is the normal state of a '
      + 'finished job. Dim lets the part show through them.',
  },
  {
    key: 'pathColorBy',
    label: 'Colour the toolpath by',
    group: 'Viewport',
    type: 'select',
    options: ['move', 'operation', 'depth', 'feed'],
    labels: {
      move: 'Kind of move — cut, plunge, rapid',
      operation: 'Operation — one hue each',
      depth: 'Depth — high Z warm, low Z cool',
      feed: 'Feed kind — cut, ramp, lead-in, plunge',
    },
    default: 'move',
    hint: 'Operation tells you which pass drew which line when eleven of them '
      + 'overlap; depth shows the levels of a roughing job at a glance; feed '
      + 'kind picks out the ramps and lead-ins that are easy to miss in blue. '
      + 'Rapids stay orange in every mode, so they are never mistaken for metal '
      + 'being cut.',
  },
  {
    key: 'lightingPreset',
    label: 'Lighting',
    group: 'Viewport',
    type: 'select',
    options: ['studio', 'soft', 'contrast', 'flat'],
    labels: {
      studio: 'Studio — key, fill and a cool rim',
      soft: 'Soft — broad and low-contrast',
      contrast: 'Contrast — one strong key, deep shadows',
      flat: 'Flat — even, for reading detail',
    },
    default: 'studio',
    hint: 'The rig the part is lit by. Contrast makes a shallow cut readable '
      + 'by its shading; Flat is for when you want colour to carry the picture, '
      + 'such as the deviation check.',
  },
  {
    key: 'envReflection',
    label: 'Reflections on metal',
    group: 'Viewport',
    type: 'select',
    options: ['minimal', 'subtle', 'normal', 'strong'],
    labels: { minimal: 'Minimal', subtle: 'Subtle', normal: 'Normal', strong: 'Strong' },
    default: 'normal',
    hint: 'How much of the surrounding room the metal surfaces mirror. A '
      + 'machined face is nearly all reflection, so this is also how bright '
      + 'steel and aluminium look. Never fully off: a metal with nothing to '
      + 'reflect renders black.',
  },

  {
    key: 'pathCutColor',
    label: 'Cutting moves',
    group: 'Viewport',
    type: 'color',
    default: PATH_COLORS.cut,
    hint: 'The colour of metal being cut. Brightness above is applied on top.',
  },
  {
    key: 'pathPlungeColor',
    label: 'Plunges and drilling',
    group: 'Viewport',
    type: 'color',
    default: PATH_COLORS.plunge,
  },
  {
    key: 'pathRapidColor',
    label: 'Rapid moves',
    group: 'Viewport',
    type: 'color',
    default: PATH_COLORS.rapid,
    hint: 'Pick colours apart enough to tell cut from rapid on the backdrop you '
      + 'chose — an orange rapid on a paper-white viewport is the first thing '
      + 'that stops being readable.',
  },

  // --- simulation ---
  {
    key: 'simQuality',
    label: 'Milling detail',
    group: 'Simulation',
    type: 'select',
    options: ['low', 'medium', 'high', 'ultra', 'extreme'],
    labels: {
      low: 'Low — fastest',
      medium: 'Medium',
      high: 'High',
      ultra: 'Ultra — slow on long programs',
      extreme: 'Extreme — 4× Ultra, needs the memory',
    },
    default: 'high',
    hint: 'How finely the stock is gridded, and the only thing that decides how '
      + 'sharp an edge can look. The depth of every cell is worked out exactly — '
      + 'a faced floor comes out dead flat at any setting — so what more cells '
      + 'buy is *across* the part, not down it: a wall lands between two samples '
      + 'and is drawn one cell thick, and that step is what reads as roughness. '
      + 'Halving it costs four times the memory, which is why Extreme is not the '
      + 'default. Nothing here can show an undercut: a grid of heights has one '
      + 'surface per place, and that is a property of the method rather than of '
      + 'the setting.',
  },
  {
    key: 'turnSamples',
    label: 'Turning detail',
    group: 'Simulation',
    type: 'select',
    options: ['400', '800', '1600', '3200'],
    labels: {
      400: 'Low — fastest', 800: 'Medium', 1600: 'High', 3200: 'Ultra',
    },
    default: '1600',
    hint: 'Samples along the bar. A groove narrower than one sample is a groove '
      + 'the simulation cannot show you.',
  },
  {
    key: 'simRecord',
    label: 'Recording limit',
    group: 'Simulation',
    type: 'select',
    options: ['1', '2', '4', '8'],
    labels: {
      1: 'Standard', 2: 'Large — 2×', 4: 'Very large — 4×', 8: 'Huge — 8×',
    },
    default: '1',
    hint: 'How much of the program the simulation can remember. Every surface '
      + 'change is written down so the timeline can scrub backwards, and a long '
      + 'program runs out — which is what "the program outran the record" '
      + 'means. Each step doubles the memory the run may use; raise it rather '
      + 'than coarsening the detail, which changes the picture instead.',
  },
  {
    key: 'simSmooth',
    label: 'Smooth the cut surface',
    group: 'Simulation',
    type: 'checkbox',
    default: true,
    hint: 'Shades the stock from averaged normals rather than facet normals. '
      + 'Machined faces read as faces instead of as a field of triangles; the '
      + 'step between two passes is still there, because it is real.',
  },
  {
    key: 'stockMaterial',
    label: 'Stock material',
    group: 'Simulation',
    type: 'select',
    options: ['classic', 'aluminium', 'steel', 'brass', 'wood', 'plastic', 'wax'],
    labels: {
      classic: 'Classic — tan billet, blue-grey cut',
      aluminium: 'Aluminium',
      steel: 'Steel',
      brass: 'Brass',
      wood: 'Wood',
      plastic: 'Plastic',
      wax: 'Machining wax',
    },
    default: 'aluminium',
    hint: 'How the billet looks, uncut and cut. Purely visual — the cutting '
      + 'data does not change with it. Each material has a dull raw face and a '
      + 'brighter machined one, because telling the two apart is the point of '
      + 'watching the simulation.',
  },
  {
    key: 'surfaceContrast',
    label: 'Cut against raw contrast',
    group: 'Simulation',
    type: 'select',
    options: ['subtle', 'normal', 'strong'],
    labels: { subtle: 'Subtle', normal: 'Normal', strong: 'Strong' },
    default: 'normal',
    hint: 'How far the machined surface stands out from the uncut billet. '
      + 'Strong darkens the raw stock and brightens the cut, which is what to '
      + 'use for spotting an uncut corner.',
  },
  {
    key: 'cutTint',
    label: 'Tint the cut by depth',
    group: 'Simulation',
    type: 'select',
    options: ['off', 'cavity', 'depth'],
    labels: {
      off: 'Off — one machined colour',
      cavity: 'Cavity shading — deeper is darker',
      depth: 'Depth colour — shallow warm, deep cool',
    },
    default: 'cavity',
    hint: 'A pocket floor is lit exactly like the top of the billet, so how '
      + 'deep a cut went is hard to read from shading alone. Cavity shading '
      + 'darkens the cut with depth, as ambient occlusion would; depth colour '
      + 'maps it to a colour ramp instead. Ignored while the deviation check '
      + 'is colouring the stock.',
  },
  {
    key: 'wallShading',
    label: 'Edge definition',
    group: 'Simulation',
    type: 'select',
    options: ['off', 'soft', 'strong'],
    labels: { off: 'Off', soft: 'Soft', strong: 'Strong' },
    default: 'soft',
    hint: 'Darkens the steep walls the cutter leaves, so a pocket edge reads '
      + 'as an edge instead of a change of brightness. Costs nothing: it '
      + 'works in the shader on the wall it has already found, and adds no '
      + 'cells.',
  },
  {
    key: 'simShadows',
    label: 'Cast the tool\'s shadow on the work',
    group: 'Simulation',
    type: 'checkbox',
    default: false,
    hint: 'A soft shadow of the cutter and holder on the stock. It shows how '
      + 'high the tool is above the surface — the one thing a still picture '
      + 'of a tool in the air cannot say. Redraws one extra depth pass per '
      + 'frame, so leave it off on a slow machine.',
  },
  {
    key: 'toolFinish',
    label: 'Cutter finish',
    group: 'Simulation',
    type: 'select',
    options: ['carbide', 'hss', 'tin', 'tialn'],
    labels: {
      carbide: 'Carbide — bright silver',
      hss: 'HSS — polished steel',
      tin: 'TiN coated — gold',
      tialn: 'TiAlN coated — dark violet',
    },
    default: 'carbide',
    hint: 'What the cutting end is made of. Cosmetic, but a dark coating '
      + 'against a pale stock is easier to follow than silver against silver.',
  },
  {
    key: 'holderColor',
    label: 'Holder colour',
    group: 'Simulation',
    type: 'select',
    options: ['slate', 'orange', 'blue', 'red', 'green'],
    labels: {
      slate: 'Slate', orange: 'Orange', blue: 'Blue', red: 'Red', green: 'Green',
    },
    default: 'slate',
    hint: 'A holder in a colour that nothing else on screen is makes a '
      + 'holder-against-work collision impossible to miss.',
  },
  {
    key: 'holderOpacity',
    label: 'Translucent holder opacity',
    group: 'Simulation',
    type: 'select',
    options: ['0.25', '0.45', '0.7'],
    labels: { 0.25: 'Faint', 0.45: 'Medium', 0.7: 'Strong' },
    default: '0.45',
    hint: 'How opaque the shank and holder are when "See through" is on.',
  },
  {
    key: 'cutMarkerStyle',
    label: 'Cut marker style',
    group: 'Simulation',
    type: 'select',
    options: ['dot', 'glow', 'sparks'],
    labels: {
      dot: 'Dot',
      glow: 'Glowing dot',
      sparks: 'Glow with a spray of chips',
    },
    default: 'glow',
    hint: 'How the contact point is drawn. All three sit on the same cell the '
      + 'simulation actually lowered; the glow and chips are decoration '
      + 'around it. Needs "Mark where the metal is coming off".',
  },
  {
    key: 'playTrail',
    label: 'Glowing trail behind the cutter',
    group: 'Simulation',
    type: 'select',
    options: ['off', 'short', 'long'],
    labels: { off: 'Off', short: 'Short', long: 'Long' },
    default: 'short',
    hint: 'A fading line over the last stretch the tool travelled during '
      + 'playback. It shows which way the tool was heading and how fast, '
      + 'which a frozen frame does not.',
  },
  {
    key: 'verify',
    label: 'Check the cut part against the model',
    group: 'Simulation',
    type: 'checkbox',
    default: true,
    hint: 'Measures the surface the program leaves against the model it was '
      + 'made from, and colours the stock by the difference: green is the part, '
      + 'blue is metal still standing on it, red is metal taken out of it. The '
      + 'one question nothing else here answers — every other check compares a '
      + 'stage with the stage before it.',
  },
  {
    key: 'verifyTolerance',
    label: 'Close enough, in mm',
    group: 'Simulation',
    type: 'select',
    options: ['0.01', '0.02', '0.05', '0.1', '0.25'],
    labels: {
      '0.01': '0.01 — a hundredth',
      '0.02': '0.02 — two hundredths',
      '0.05': '0.05 — a twentieth',
      0.1: '0.1 — a tenth',
      0.25: '0.25 — a quarter',
    },
    default: '0.05',
    hint: 'How far off the model still counts as on it. Set below the '
      + 'simulation\'s own cell size and every sloped face reports as rough, '
      + 'because a grid draws a slope in steps — the detail setting is the '
      + 'floor on what this can honestly resolve.',
  },
  {
    key: 'tiltDisplay',
    label: 'Show a tilted cut by moving',
    group: 'Simulation',
    type: 'select',
    options: TILT_DISPLAYS,
    labels: TILT_DISPLAY_LABELS,
    default: 'tool',
    hint: 'A 5-axis cut is one relative motion and three kinds of machine make '
      + 'it. A head-head machine leans the spindle over a part that stays put; a '
      + 'table-table trunnion keeps the spindle upright and tilts and turns the '
      + 'part under it; a head-table machine leans the spindle one way and turns '
      + 'the part the other. The cut is the same in all three, and so is the '
      + 'program — this only chooses which one the simulation draws, so that '
      + 'what is on screen moves the way the machine in front of you will. It '
      + 'can be changed from the simulation bar while a program plays.',
  },
  {
    key: 'showHolder',
    label: 'Draw the shank and holder',
    group: 'Simulation',
    type: 'checkbox',
    default: true,
    hint: 'A 40mm holder coming down into a 30mm pocket is a crash. It can only '
      + 'be seen if the holder is drawn.',
  },
  {
    key: 'ghostTool',
    label: 'See through the shank and holder',
    group: 'Simulation',
    type: 'checkbox',
    default: false,
    hint: 'The holder is the part most likely to be between you and the cut. '
      + 'Off, the tool is drawn solid — which is what it is, and what makes it '
      + 'obvious when the holder is inside the work rather than in front of it.',
  },
  {
    key: 'showCutMarker',
    label: 'Mark where the metal is coming off',
    group: 'Simulation',
    type: 'checkbox',
    default: true,
    hint: 'A dot on the surface the cutter is actually removing this instant. '
      + 'The cutter is drawn from its own silhouette and the stock from the '
      + 'swept height grid, and the only way to see that those two agree is to '
      + 'mark the place they touch — if the dot is not under the corner of the '
      + 'tool, one of them is wrong.',
  },
  {
    key: 'spinWork',
    label: 'Spin the work on the lathe',
    group: 'Simulation',
    type: 'checkbox',
    default: true,
  },

  // --- editing ---
  {
    key: 'hintStyle',
    label: 'Explain each setting',
    group: 'Editing',
    type: 'select',
    options: ['bubble', 'inline', 'off'],
    labels: {
      bubble: 'On hover, in a bubble',
      inline: 'Always, under the field',
      off: 'Not at all',
    },
    default: 'bubble',
    hint: 'Most of these settings are a distance on a picture, so the bubble '
      + 'carries the picture with the dimension it controls picked out. Printed '
      + 'under every field instead, the same text is most of the height of the '
      + 'panel and pushes the fields it explains apart.',
  },
  {
    key: 'confirmDelete',
    label: 'Ask before a deletion that reaches further than one row',
    group: 'Editing',
    type: 'checkbox',
    default: true,
    hint: 'Deleting a setup takes its operations with it, and deleting a tool '
      + 'stops every operation that used it. Both are undoable either way.',
  },
  {
    key: 'autosave',
    label: 'Keep the session in this browser',
    group: 'Editing',
    type: 'checkbox',
    default: true,
    hint: 'Restores what you had open after a reload, geometry included. '
      + 'Switching it off also forgets the session already kept, so a reload '
      + 'starts empty rather than on whatever was open when it was last on.',
  },
  {
    key: 'autosaveDelay',
    label: 'Save the session after',
    group: 'Editing',
    type: 'select',
    options: ['0.4', '3', '15', '60'],
    labels: {
      0.4: 'Every edit — nearly at once',
      3: '3 seconds of quiet',
      15: '15 seconds of quiet',
      60: 'A minute of quiet',
    },
    default: '0.4',
    hint: 'How long after the last change the session is written. A large '
      + 'STEP model is megabytes per write, so a longer wait spares a slow disk; '
      + 'a pending save is still made when the tab is hidden or closed.',
  },
];

// Actions carry no value, so they are kept out of the stored preferences
// entirely — a key whose default is `undefined` would be written into the
// settings blob on the first save and read back as a setting nobody set.
const DEFAULTS = Object.fromEntries(
  SETTINGS.filter((s) => s.type !== 'action').map((s) => [s.key, s.default]));

let cache = null;

function readAll() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    stored = {};   // private mode, or something else wrote to the key
  }
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

/** Every setting, defaults filled in. */
export function allSettings() {
  return { ...readAll() };
}

export function getSetting(key) {
  const value = readAll()[key];
  return value === undefined ? DEFAULTS[key] : value;
}

/** Is the 5-axis beta switched on? Read at the moment of use, never cached. */
export function fiveAxisEnabled() {
  return getSetting('fiveAxisBeta') === true;
}

export function setSetting(key, value) {
  const next = { ...readAll(), [key]: value };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* private mode: the setting still applies to this session */ }
  return next;
}

export function resetSettings() {
  cache = { ...DEFAULTS };
  try { localStorage.removeItem(KEY); } catch { /* nothing to remove */ }
  return cache;
}

/** Grid cells for the milling simulation, by quality name. */
export const SIM_CELLS = {
  low: 15_000,
  medium: 40_000,
  high: 120_000,
  ultra: 400_000,
  // Cell size goes as 1/√cells, so this is Ultra's edges halved — 0.033mm on an
  // 80mm billet. The event budget scales with the grid (see eventBudget), so
  // raising this does not quietly truncate the run the way a fixed budget did.
  extreme: 1_600_000,
};

// --- preferences as a file ---------------------------------------------------

const VALID_COLOR = /^#[0-9a-f]{6}$/i;

/** Is `value` something this setting could hold? Imports are checked, not trusted. */
function acceptable(setting, value) {
  if (setting.type === 'checkbox') return typeof value === 'boolean';
  if (setting.type === 'select') return setting.options.includes(String(value));
  if (setting.type === 'color') return typeof value === 'string' && VALID_COLOR.test(value);
  return Number.isFinite(value)
    && (setting.min === undefined || value >= setting.min)
    && (setting.max === undefined || value <= setting.max);
}

/** Every preference as JSON text, for a file. Actions carry no value. */
export function exportSettings() {
  return JSON.stringify({ cncam: 'preferences', settings: allSettings() }, null, 2);
}

/**
 * Apply preferences from JSON text.
 *
 * Unknown keys and values this build would not accept are skipped and counted
 * rather than stored: a file from a newer build, or one edited by hand, must not
 * be able to put a setting into a state its control cannot show.
 *
 * @returns { applied: string[], skipped: number } the keys that changed
 */
export function importSettings(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not JSON'); }
  const incoming = data?.cncam === 'preferences' ? data.settings : null;
  if (!incoming || typeof incoming !== 'object') {
    throw new Error('That file is not a CNCAM preferences file');
  }
  const applied = [];
  let skipped = 0;
  for (const [key, value] of Object.entries(incoming)) {
    const setting = SETTINGS.find((s) => s.key === key && s.type !== 'action');
    if (!setting || !acceptable(setting, value)) { skipped++; continue; }
    if (getSetting(key) !== value) applied.push(key);
    setSetting(key, value);
  }
  return { applied, skipped };
}
