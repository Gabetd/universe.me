import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { airUniforms, CLOUD_GLSL, CLOUD_M, SKY_GLSL } from './groundAir'
import { noRaycast } from './pick'
import { WEBGL } from './webgl'

/**
 * The ground view's sky (PLAN.md §5.2): a dome around the camera, deep blue
 * overhead and pale at the horizon, with the sun and its glow, and clouds
 * that drift on the wind (their shadows are the land's, see `inTheAir`). Far
 * land fades into the horizon's colour, the haze's (see `HAZE_M`).
 */

/** How often the sky's clouds move on while the view is just being looked at: not at all when it's drawn in software (each frame costs a CPU dearly), where they move as the view is redrawn anyway. */
const DRIFT_FPS = WEBGL.software ? 0 : 12

const vertexShader = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  // Around the camera, at the far plane: behind everything.
  vec4 p = projectionMatrix * viewMatrix * vec4(cameraPosition + position * 1000.0, 1.0);
  gl_Position = p.xyww;
}
`

const fragmentShader = /* glsl */ `
uniform vec3 uCamera;
varying vec3 vDir;
${CLOUD_GLSL}
${SKY_GLSL}
void main() {
  vec3 dir = normalize(vDir);
  float up = dir.y;
  float sun = max(dot(dir, uSunDir), 0.0);
  // Overhead deep, toward the horizon paler, and below it the haze over the land.
  vec3 sky = skyAlong(dir);
  sky = mix(sky, uHorizon, smoothstep(0.02, -0.03, up));
  // The sun's glow, and the disc itself.
  sky += uSunColor * uSunScale * (0.25 * pow(sun, 8.0) + 0.35 * pow(sun, 64.0));
  sky += uSunColor * uSunScale * smoothstep(0.9994, 0.9997, sun) * 2.0;
  // Clouds, where the line of sight meets their layer.
  if (up > 0.0) {
    float t = (${CLOUD_M.toFixed(1)} - uCamera.y) / max(up, 1e-3);
    vec2 at = uCamera.xz + dir.xz * t;
    float cover = cloudCover(at, 5);
    // Lit tops toward the sun, grey undersides, and the thinner edges letting the sky through.
    float lit = 1.0 - 0.65 * cloudCover(at + normalize(uSunDir.xz) * 350.0, 3);
    vec3 cloud = mix(vec3(0.62, 0.66, 0.72), vec3(1.0), clamp(lit, 0.0, 1.0)) * mix(vec3(1.0), uSunColor, 0.35) * (0.55 + 0.45 * uSunScale);
    cloud += uSunColor * uSunScale * 0.3 * pow(sun, 6.0);
    // Far off, the clouds thin into the haze at the horizon.
    float fade = smoothstep(0.0, 0.12, up);
    sky = mix(sky, cloud, cover * fade * 0.92);
  }
  gl_FragColor = vec4(sky, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/**
 * The sky dome, its colours from the theme in force: `zenith` overhead,
 * `horizon` at the horizon (the haze's colour, so far land fades into it),
 * and the sun's colour and strength.
 */
export function GroundSky({ zenith, horizon, sun, sunScale }: { zenith: string; horizon: string; sun: string; sunScale: number }) {
  const camera = useThree((s) => s.camera)
  const invalidate = useThree((s) => s.invalidate)
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { ...airUniforms, uCamera: { value: new THREE.Vector3() } },
        vertexShader,
        fragmentShader,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false
      }),
    []
  )
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => {
    airUniforms.uZenith.value.set(zenith)
    airUniforms.uHorizon.value.set(horizon)
    airUniforms.uSunColor.value.set(sun)
    airUniforms.uSunScale.value = sunScale
    invalidate()
  }, [zenith, horizon, sun, sunScale, invalidate])
  // The clouds drift: a few frames a second while the window shows, more as the view moves anyway.
  useEffect(() => {
    if (!DRIFT_FPS) return
    const timer = setInterval(() => document.visibilityState === 'visible' && invalidate(), 1000 / DRIFT_FPS)
    return () => clearInterval(timer)
  }, [invalidate])
  useFrame((state) => {
    airUniforms.uCloudTime.value = state.clock.elapsedTime
    material.uniforms.uCamera!.value.copy(camera.position)
  })
  return (
    <mesh material={material} renderOrder={-1000} frustumCulled={false} raycast={noRaycast}>
      <sphereGeometry args={[1, 48, 24]} />
    </mesh>
  )
}
