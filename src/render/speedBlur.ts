import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Radial motion blur toward the centre of view, weighted to the screen edges: at speed the periphery smears while
 * the point you're driving at stays sharp, as it does for a driver. Strength 0 costs one texture read.
 */
export function createSpeedBlurPass(): ShaderPass & { setStrength(strength: number): void } {
  const pass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      strength: { value: 0 },
      center: { value: [0.5, 0.56] },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float strength;
      uniform vec2 center;
      varying vec2 vUv;
      void main() {
        vec4 base = texture2D(tDiffuse, vUv);
        if (strength <= 0.0) {
          gl_FragColor = base;
          return;
        }
        vec2 toCenter = center - vUv;
        // Nothing in the middle third of the screen, full strength at the edges.
        float edge = smoothstep(0.18, 0.62, length(toCenter * vec2(1.6, 1.0)));
        vec2 stepUv = toCenter * strength * edge / 8.0;
        vec4 sum = base;
        for (int i = 1; i < 8; i++) sum += texture2D(tDiffuse, vUv + stepUv * float(i));
        gl_FragColor = sum / 8.0;
      }`,
  }) as ShaderPass & { setStrength(strength: number): void };
  pass.setStrength = (strength: number) => {
    pass.uniforms.strength.value = strength;
  };
  return pass;
}
