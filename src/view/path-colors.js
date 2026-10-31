// The built-in toolpath colours, as hex — the one description of them.
//
// Kept apart from view/toolpath.js because the preferences read them for their
// defaults (app/settings.js), and settings are loaded by the node test suite,
// which has no `three` to resolve: a module that imports the renderer cannot be
// the home of a table the settings need. The rapid is the orange it always was,
// already stepped back the way it used to be by a multiplier, so a stored
// colour is exactly the colour drawn.
export const PATH_COLORS = {
  rapid: '#cd7d46',
  cut: '#5aa8ec',
  plunge: '#e8c25e',
};
