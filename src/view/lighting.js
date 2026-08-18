// The room the part is standing in.
//
// Every material in the viewport is a MeshStandardMaterial, and half of them
// are metal: the stock at 0.35, the cutter at 0.75, the chuck at 0.5. That is
// the right description of what they are and it renders almost black without an
// environment, because a physically-based metal has **no diffuse response at
// all** — everything you see on a metal surface is a reflection of its
// surroundings, and the surroundings here were "nothing".
//
// That is the whole of "the shading is weird, and the lathe view is very dark".
// It was worst on the lathe because its default view looks along −Y at the ZX
// plane, where the two directional lights contribute least; the mill's iso view
// happened to catch the key light and so looked merely flat rather than black.
// Adding a third light would have been treating the symptom — the surfaces were
// not underlit, they were unreflected.
//
// So: a small procedural room, blurred into an irradiance map by three's PMREM
// generator, exactly as RoomEnvironment does. Built here rather than vendored
// because what it has to be is a light grey box with a bright ceiling, and that
// is a dozen lines.

import * as THREE from 'three';

/**
 * A vertical gradient standing in for a workshop: bright overhead, mid grey at
 * eye level, dark underfoot. Equirectangular, so `v` runs from the zenith at 0
 * to the nadir at 1.
 */
function gradientTexture() {
  const width = 32;
  const height = 128;
  const data = new Uint8Array(width * height * 4);
  const stops = [
    [0.00, [255, 255, 255]],   // ceiling lights
    [0.35, [190, 196, 206]],   // upper wall
    [0.55, [120, 126, 136]],   // eye level
    [0.80, [58, 61, 68]],      // lower wall
    [1.00, [30, 32, 36]],      // floor
  ];
  const sample = (v) => {
    let i = 1;
    while (i < stops.length - 1 && stops[i][0] < v) i++;
    const [v0, c0] = stops[i - 1];
    const [v1, c1] = stops[i];
    const t = v1 === v0 ? 0 : (v - v0) / (v1 - v0);
    return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * t);
  };

  for (let y = 0; y < height; y++) {
    const [r, g, b] = sample(y / (height - 1));
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Give a scene something for its metals to reflect.
 *
 * @returns a dispose function — the PMREM render target is GPU memory and the
 *   viewport is torn down and rebuilt when the app reloads a project
 */
/**
 * A dim light that always shines from where you are standing.
 *
 * Both key lights are overhead, because that is where light comes from — and it
 * means every *vertical* surface in the scene is lit at grazing incidence and
 * comes out nearly black. The tool holder measured eight levels above the
 * background: it is drawn so that you can see it fouling the work, and it could
 * not be seen at all. The wall of a pocket and the side of the billet are the
 * same surface and had the same problem.
 *
 * A headlight is the standard answer and the honest one: a viewport is not a
 * photograph, and the surface you are looking at is the surface you want to
 * see. Kept dim, so it fills the shadows without flattening the form the key
 * lights give.
 *
 * @returns a function to call before each render, with the active camera
 */
export function installHeadlight(scene, intensity = 0.45) {
  const light = new THREE.DirectionalLight(0xffffff, intensity);
  scene.add(light);
  scene.add(light.target);
  return (camera) => {
    light.position.copy(camera.position);
    camera.getWorldDirection(light.target.position);
    light.target.position.multiplyScalar(10).add(camera.position);
    light.target.updateMatrixWorld();
  };
}

export function installEnvironment(scene, renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const source = gradientTexture();
  const target = pmrem.fromEquirectangular(source);
  scene.environment = target.texture;
  source.dispose();
  pmrem.dispose();
  return () => {
    scene.environment = null;
    target.dispose();
  };
}
