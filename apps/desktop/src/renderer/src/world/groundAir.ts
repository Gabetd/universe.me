import { HORIZON_M } from '@universe/procgen'
import * as THREE from 'three'

/**
 * The air over the ground view (PLAN.md §5.2): the haze, the planet's curve
 * and the clouds' shadows, shared by the sky and the land so they agree.
 *
 * The haze thickens with distance as real air does (exponentially), so near
 * land is clear and far mountains are paler but still there, fading into the
 * horizon's colour; the ground view is the only view with fog, so three's
 * exponential fog is made that, everywhere. The land curves down away from
 * the camera with the planet, so the sea has a horizon and the land beyond
 * it sinks behind.
 */
THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace('fogDensity * fogDensity * vFogDepth * vFogDepth', 'fogDensity * vFogDepth').replace(
  'gl_FragColor.rgb = mix(',
  // The ground ends at HORIZON_M (the last of its rings): before then, the haze has taken all of it.
  `fogFactor = max( fogFactor, smoothstep( ${(HORIZON_M * 0.7).toFixed(1)}, ${HORIZON_M.toFixed(1)}, vFogDepth ) );\n\tgl_FragColor.rgb = mix(`
)

/** How far the air takes to hide about two thirds of what's behind it, in metres, in the usual air: mountains 50 km off still show, paler. */
export const HAZE_M = 55_000
/** How high the clouds float, in metres above sea level. */
export const CLOUD_M = 2200
/** How fast the wind carries the clouds, in metres a second (east and south). */
const WIND = [7, 3] as const

/** The sun's direction: high in the south-east, so the land ahead (north) is lit and shaded by its hills. */
export const SUN_DIR = new THREE.Vector3(0.55, 0.62, 0.56).normalize()
/** Where the sun's light comes from, as a position for a directional light. */
export const SUN_POSITION = SUN_DIR.clone().multiplyScalar(1000).toArray()

/** Uniforms shared by every material of the air: change their values here and all of them follow. */
export const airUniforms = {
  uCloudTime: { value: 0 },
  /** The view's frame's origin in a frame that doesn't move (metres), so clouds stay put as the view starts a new frame. */
  uCloudOrigin: { value: new THREE.Vector2() },
  uSunDir: { value: SUN_DIR.clone() },
  /** How far the land drops per square metre away from the camera: 1 / (2 × the planet's radius). */
  uCurve: { value: 0 },
  /** The sky overhead and at the horizon, and the sun's colour and strength: set by the sky, reflected by the water. */
  uZenith: { value: new THREE.Color() },
  uHorizon: { value: new THREE.Color() },
  uSunColor: { value: new THREE.Color() },
  uSunScale: { value: 1 },
  /** Where the chunks are, all of them built: the middle of their square (x, z in the view's frame) and how far each way the rings of ground sink under them (0 while they're being built). */
  uUnderChunks: { value: new THREE.Vector3() }
}

/** How far the rings of ground sink where the chunks are: out of the way of what stands on them. */
const UNDER_CHUNKS_SINK_M = 60

/** Moves the clouds' frame by what the view's frame moved: they stay where they were over the land. */
export function shiftClouds(dx: number, dz: number): void {
  airUniforms.uCloudOrigin.value.x += dx
  airUniforms.uCloudOrigin.value.y += dz
}

/** Sets the planet's curve for a radius in km. */
export function setCurve(radiusKm: number): void {
  airUniforms.uCurve.value = 1 / (2 * radiusKm * 1000)
}

/** GLSL: value noise, and the clouds' cover at a point of the cloud layer (metres in the view's frame), 0 to 1. */
export const CLOUD_GLSL = /* glsl */ `
uniform float uCloudTime;
uniform vec2 uCloudOrigin;
uniform vec3 uSunDir;
float cloudHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float cloudNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cloudHash(i), cloudHash(i + vec2(1, 0)), u.x), mix(cloudHash(i + vec2(0, 1)), cloudHash(i + vec2(1, 1)), u.x), u.y);
}
// The clouds' cover with \`octaves\` of detail (5 for the clouds themselves; their shadows, soft anyway, need fewer).
float cloudCover(vec2 metres, int octaves) {
  vec2 world = metres + uCloudOrigin;
  vec2 p = (world - vec2(${WIND[0].toFixed(1)}, ${WIND[1].toFixed(1)}) * uCloudTime) / 2600.0;
  float f = 0.0, a = 0.55;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    f += a * cloudNoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5;
  }
  // Big, slow patches of fairer and cloudier weather.
  float weather = cloudNoise(world / 40000.0 + 3.7);
  return smoothstep(0.5 - 0.14 * weather, 0.78, f);
}
`

/** GLSL: the sky's colour looking along a direction (overhead to the horizon); and small ripples on water. */
export const SKY_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform float uSunScale;
vec3 skyAlong(vec3 dir) {
  return mix(uHorizon, uZenith, pow(clamp(dir.y, 0.0, 1.0), 0.45));
}
// Ripples' height; \`fine\` (0 to 1) takes in the smallest, which only show up close.
float ripples(vec2 p, float fine) {
  float t = uCloudTime;
  return cloudNoise(p * 0.11 + vec2(t * 0.21, t * 0.13)) + 0.6 * cloudNoise(p * 0.37 - vec2(t * 0.33, -t * 0.27)) + 0.3 * fine * cloudNoise(p * 1.1 + vec2(-t * 0.6, t * 0.5));
}
`

/** What else a material in the air does (see `inTheAir`). */
interface AirLook {
  /** Darkened under the clouds' shadows. */
  shadows?: boolean
  /** The land's fine grain: its colour varies over metres, up close. */
  grain?: boolean
  /** Water: rippled, reflecting the sky (more at a glancing angle) and the sun. */
  water?: boolean
  /** White water where a `foam` attribute (0 to 1) says so. */
  foam?: boolean
  /** Ground beyond the chunks: sunk where they are (see `uUnderChunks`). */
  underChunks?: boolean
}

/**
 * Makes a lit material part of the air: curved down with the planet away from
 * the camera, and as `look` asks, in the clouds' shadows, grained like land,
 * or rippling like water.
 */
export function inTheAir<M extends THREE.Material>(material: M, look: AirLook = {}): M {
  const { shadows = true, grain = false, water = false, foam = false, underChunks = false } = look
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, airUniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uCurve;\nuniform vec3 uUnderChunks;\nvarying vec3 vAirWorld;${foam ? '\nattribute float foam;\nvarying float vFoam;' : ''}`)
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        vec4 airWorld = modelMatrix * mvPosition;${underChunks ? `\n        if ( max( abs( airWorld.x - uUnderChunks.x ), abs( airWorld.z - uUnderChunks.y ) ) < uUnderChunks.z ) airWorld.y -= ${UNDER_CHUNKS_SINK_M.toFixed(1)};` : ''}
        vec2 airAway = airWorld.xz - cameraPosition.xz;
        airWorld.y -= dot( airAway, airAway ) * uCurve;
        vAirWorld = airWorld.xyz;${foam ? '\n        vFoam = foam;' : ''}
        mvPosition = viewMatrix * airWorld;
        gl_Position = projectionMatrix * mvPosition;`
      )
    let fragment = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vAirWorld;${foam ? '\nvarying float vFoam;' : ''}\n${CLOUD_GLSL}\n${SKY_GLSL}`)
    if (grain)
      fragment = fragment.replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        // Up close, the ground isn't one smooth colour: lighter and darker over a few metres and tens of metres, a little yellower or greener.
        float airNear = 1.0 - smoothstep( 150.0, 700.0, distance( vAirWorld, cameraPosition ) );
        vec2 airAt = vAirWorld.xz;
        float airFine = cloudNoise( airAt / 2.3 ) + 0.7 * cloudNoise( airAt / 7.9 + 31.0 );
        float airBroad = cloudNoise( airAt / 41.0 + 7.0 );
        diffuseColor.rgb *= mix( 1.0, 0.82 + 0.22 * airFine / 1.7, airNear );
        diffuseColor.rgb *= 1.0 + ( airBroad - 0.5 ) * vec3( 0.12, 0.04, -0.1 );`
      )
    if (shadows)
      fragment = fragment.replace(
        '#include <aomap_fragment>',
        /* glsl */ `
        // Where the sunlight reaching this point passed through the cloud layer.
        float airShade = 1.0 - 0.5 * cloudCover( vAirWorld.xz + uSunDir.xz / max( uSunDir.y, 0.1 ) * ( ${CLOUD_M.toFixed(1)} - vAirWorld.y ), 3 );
        reflectedLight.directDiffuse *= airShade;
        reflectedLight.directSpecular *= airShade;
        #include <aomap_fragment>`
      )
    if (water)
      fragment = fragment.replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        // Ripples tilt the surface; it reflects the sky, more at a glancing angle, and glints in the sun.
        vec3 airEye = normalize( cameraPosition - vAirWorld );
        // Farther off, the ripples are smaller than a pixel: the water evens out to a smooth sheen.
        float airDist = distance( vAirWorld, cameraPosition );
        float airFar = smoothstep( 60.0, 1500.0, airDist );
        float airFine = 1.0 - smoothstep( 30.0, 150.0, airDist );
        vec2 airP = vAirWorld.xz;
        float airH = ripples( airP, airFine );
        vec2 airSlope = vec2( ripples( airP + vec2( 1.5, 0.0 ), airFine ) - airH, ripples( airP + vec2( 0.0, 1.5 ), airFine ) - airH ) * mix( 0.45, 0.03, airFar );
        vec3 airN = normalize( vec3( -airSlope.x, 1.0, -airSlope.y ) );
        float airFresnel = 0.03 + 0.97 * pow( 1.0 - max( dot( airN, airEye ), 0.0 ), 5.0 );
        vec3 airRefl = reflect( -airEye, airN );
        float airWhite = ${foam ? 'vFoam * ( 0.75 + 0.5 * cloudNoise( airP * 0.4 - vec2( 0.0, uCloudTime * 2.0 ) ) )' : '0.0'};
        outgoingLight = mix( outgoingLight, skyAlong( airRefl ), airFresnel * 0.85 * ( 1.0 - airWhite ) );
        outgoingLight += uSunColor * uSunScale * pow( max( dot( airRefl, uSunDir ), 0.0 ), 400.0 ) * 3.0 * ( 1.0 - airWhite );
        outgoingLight = mix( outgoingLight, vec3( 0.93, 0.95, 0.97 ) * ( 0.6 + 0.4 * uSunScale ), clamp( airWhite, 0.0, 1.0 ) );
        diffuseColor.a = mix( diffuseColor.a, 1.0, max( airFresnel, airWhite ) );
        #include <opaque_fragment>`
      )
    shader.fragmentShader = fragment
  }
  // One program for every material made alike.
  material.customProgramCacheKey = () => `air:${shadows}:${grain}:${water}:${foam}`
  return material
}
