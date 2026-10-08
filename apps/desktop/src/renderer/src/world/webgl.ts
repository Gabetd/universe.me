/**
 * What this computer's WebGL can do, asked once. It can be missing (old GPUs,
 * remote desktops; the map still works without it), or drawn in software
 * (SwiftShader and the like, on machines without a GPU), where antialiasing
 * costs more than the rest of a frame.
 */
export const WEBGL = (() => {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return { available: false, software: false }
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return { available: true, software: /swiftshader|llvmpipe|softpipe|basic render driver/i.test(renderer) }
  } catch {
    return { available: false, software: false }
  }
})()
