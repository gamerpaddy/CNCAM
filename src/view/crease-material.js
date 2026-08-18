// Keeping a height grid from smearing its walls across the floor beside them.
//
// The cut stock is a lattice of quads and a machined wall is *one column* of
// them: the cell at the top of the wall and the cell at the bottom are
// neighbours, one cell apart in XY and a whole depth of cut apart in Z. The
// exact height-grid normal at those two cells is therefore almost horizontal —
// correctly, they are the wall — and Gouraud interpolation then carries that
// horizontal normal out across the *flat* quad on either side of it, because
// that quad shares the vertex.
//
// The visible result is a dark band one cell wide running along the foot and
// the lip of every wall, and since the wall wanders between grid columns as it
// curves, the band flickers from column to column: the vertical striping that
// makes a simulated part read as jagged. Nothing about the geometry is wrong
// — the positions are exactly where the simulation put them. It is a shading
// artefact of averaging across an edge that is not meant to be smooth.
//
// geom/shading.js already solves this problem for imported models, by not
// averaging two faces whose angle is steeper than the crease angle. It does it
// on the CPU, by splitting vertices — which a mesh that is rewritten a few
// thousand times a second cannot afford. So the same rule is applied in the
// fragment shader instead: the face's own normal is available there from the
// screen-space derivatives of the view position, and where it disagrees with
// the interpolated normal by more than the crease angle, the face wins.
//
// Floors keep their smooth normal (their face normal agrees with it), walls get
// a true horizontal one, and the crease between them is exactly one pixel
// wide. Cost: a dozen instructions per fragment and nothing per frame on the
// CPU.

import { DEFAULT_CREASE_DEG } from '../geom/shading.js';

const CREASE_CHUNK = `
  {
    vec3 fdx = dFdx( vViewPosition );
    vec3 fdy = dFdy( vViewPosition );
    vec3 creaseFace = cross( fdx, fdy );
    float creaseLen = length( creaseFace );
    if ( creaseLen > 1e-12 ) {
      creaseFace /= creaseLen;
      // the shading normal has already been flipped for the facing side, so
      // the face normal is put in the same hemisphere before they are compared
      if ( dot( creaseFace, normal ) < 0.0 ) creaseFace = -creaseFace;
      if ( dot( creaseFace, normal ) < uCreaseCos ) normal = creaseFace;
    }
  }
`;

/**
 * Which way a wall actually faces, when the grid only knows two answers.
 *
 * A wall in a height grid is the quad joining a high cell to the low cell next
 * to it, so it lies in a grid plane and its face normal is exactly ±X or ±Y.
 * That is fine for a wall along a grid line and wrong for every other one: the
 * fillet in the corner of a pocket is a staircase of those quads, and lighting
 * it by its facets is the vertical banding that makes a simulated corner read
 * as jagged. Nothing is wrong with the geometry — the corner really is a
 * staircase, to within a cell — but its *facets* are an artefact of the grid
 * and not of the cut, and shading them says the opposite.
 *
 * So the direction the surface falls away in is measured over a few cells and
 * carried per vertex (`aWall`), and where the crease rule has just decided this
 * fragment is a wall, the face normal keeps its steepness and takes its
 * compass bearing from that instead. A straight wall is unchanged — the
 * measured bearing is the grid direction — and a curved one comes out curved.
 */
const WALL_VERTEX = `
  attribute vec2 aWall;
  varying vec3 vWallDir;
  varying vec3 vWallUp;
`;

const WALL_VERTEX_BODY = `
  vWallDir = normalMatrix * vec3( aWall, 0.0 );
  vWallUp = normalize( normalMatrix * vec3( 0.0, 0.0, 1.0 ) );
`;

const WALL_CHUNK = `
  {
    vec3 fdx = dFdx( vViewPosition );
    vec3 fdy = dFdy( vViewPosition );
    vec3 creaseFace = cross( fdx, fdy );
    float creaseLen = length( creaseFace );
    if ( creaseLen > 1e-12 ) {
      creaseFace /= creaseLen;
      if ( dot( creaseFace, normal ) < 0.0 ) creaseFace = -creaseFace;
      if ( dot( creaseFace, normal ) < uCreaseCos ) {
        float bearing = length( vWallDir );
        if ( bearing > 0.5 ) {
          // split the facet into how far it leans and which way it points, and
          // keep only the lean
          float lean = dot( creaseFace, vWallUp );
          vec3 flat0 = creaseFace - lean * vWallUp;
          vec3 aim = vWallDir / bearing;
          if ( dot( aim, flat0 ) < 0.0 ) aim = -aim;
          creaseFace = normalize( lean * vWallUp + length( flat0 ) * aim );
        }
        normal = creaseFace;
      }
    }
  }
`;

/**
 * Shade `material` smoothly except across creases.
 *
 * @param material a MeshStandardMaterial (or any lit material using the
 *   `normal_fragment_begin` chunk)
 * @param creaseDeg faces meeting at more than this are an edge, not a surface —
 *   the same angle geom/shading.js uses on models, so a chamfer looks like a
 *   chamfer whether it was imported or machined
 * @param walls whether the geometry carries an `aWall` bearing per vertex —
 *   see WALL_CHUNK. Off by default, because a mesh without the attribute would
 *   read it as zero and pay for the branch to learn nothing.
 */
export function shadeWithCreases(material, creaseDeg = DEFAULT_CREASE_DEG, walls = false) {
  material.userData.creaseDeg = creaseDeg;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCreaseCos = { value: Math.cos((creaseDeg * Math.PI) / 180) };
    if (walls) {
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${WALL_VERTEX}\nvoid main() {`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WALL_VERTEX_BODY}`);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {',
        `uniform float uCreaseCos;\n${walls ? 'varying vec3 vWallDir;\nvarying vec3 vWallUp;\n' : ''}void main() {`)
      .replace('#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>\n${walls ? WALL_CHUNK : CREASE_CHUNK}`);
  };
  // Programs are cached by their defines, and this one is not a define — two
  // materials that differ only by this would otherwise share a compiled
  // program and one of them would be shaded by the other's rule.
  material.customProgramCacheKey = () => `crease:${creaseDeg}:${walls ? 'w' : ''}`;
  return material;
}
