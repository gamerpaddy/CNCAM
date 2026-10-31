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
  const aim = (camera) => {
    light.position.copy(camera.position);
    camera.getWorldDirection(light.target.position);
    light.target.position.multiplyScalar(10).add(camera.position);
    light.target.updateMatrixWorld();
  };
  aim.light = light;   // so a rig can change its strength without a second one
  return aim;
}

/**
 * The whole rig in one place, and the one description of it.
 *
 * The lights used to be constructed in viewport.js with their numbers inline,
 * which left no way to change them short of editing the constructor. A preset
 * is a row here, so a new look is a new row and nothing else.
 *
 * Studio is the rig the app has always had (sky, a key from one side, a fill
 * from the other, the headlight) plus a cool rim light that trails the camera:
 * a rim from a fixed place would light the edges of a mill's part and leave a
 * lathe's in the dark, because the two are looked at from opposite sides.
 *
 * @returns { apply({ preset, reflection }), aim(camera) } — `aim` replaces
 *   the bare headlight function and is called at the same place, before each
 *   render
 */
const LIGHT_PRESETS = {
  studio: {
    sky: 0.5, key: 1.15, fill: 0.7, rim: 0.55, head: 0.45,
    keyColor: 0xfff3e4, fillColor: 0xe4eeff, rimColor: 0xbcd4ff,
  },
  soft: {
    sky: 0.95, key: 0.6, fill: 0.55, rim: 0.3, head: 0.5,
    keyColor: 0xffffff, fillColor: 0xffffff, rimColor: 0xdde8ff,
  },
  contrast: {
    sky: 0.2, key: 1.9, fill: 0.25, rim: 0.7, head: 0.2,
    keyColor: 0xfff0dc, fillColor: 0xd8e4ff, rimColor: 0xaecaff,
  },
  flat: {
    sky: 1.25, key: 0.45, fill: 0.45, rim: 0, head: 0.7,
    keyColor: 0xffffff, fillColor: 0xffffff, rimColor: 0xffffff,
  },
};

/** How strongly the room is mirrored, by name — see the envReflection setting. */
const REFLECTION = { minimal: 0.25, subtle: 0.55, normal: 0.9, strong: 1.5 };

export function installLightRig(scene) {
  // A hemisphere light's "sky" is whichever way its position points, and the
  // default is +Y. This scene is Z-up, so the sky is put on +Z — otherwise the
  // −Y face of every part, the one the mill's default view looks straight at,
  // is lit as if it were underneath.
  const sky = new THREE.HemisphereLight(0xffffff, 0x333944, 0.5);
  sky.position.set(0, 0, 1);
  scene.add(sky);
  // Lit from both sides of the table, because the two machines are looked at
  // from opposite ones: a mill from −Y, a lathe from +Y (the chuck has to be
  // on the left). One key light meant whichever machine was not the one it was
  // aimed at showed the part in silhouette.
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(100, -60, 150);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-60, 100, 120);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0);
  scene.add(rim);
  scene.add(rim.target);
  const head = installHeadlight(scene);
  const headLight = head.light;

  const apply = ({ preset, reflection } = {}) => {
    if (preset !== undefined) {
      const p = LIGHT_PRESETS[preset] ?? LIGHT_PRESETS.studio;
      sky.intensity = p.sky;
      key.intensity = p.key; key.color.set(p.keyColor);
      fill.intensity = p.fill; fill.color.set(p.fillColor);
      rim.intensity = p.rim; rim.color.set(p.rimColor);
      headLight.intensity = p.head;
    }
    if (reflection !== undefined) {
      scene.environmentIntensity = REFLECTION[reflection] ?? REFLECTION.normal;
    }
  };
  apply({ preset: 'studio', reflection: 'normal' });

  return {
    apply,
    aim(camera) {
      head(camera);
      // opposite the camera across the part, and a little above it
      rim.position.set(-camera.position.x, -camera.position.y, Math.abs(camera.position.z) * 0.6 + 40);
      rim.target.position.set(0, 0, 0);
      rim.target.updateMatrixWorld();
    },
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
