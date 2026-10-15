import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * The final look, after tone mapping: a colour grade (more contrast and saturation, warm highlights, cool shadows)
 * and the sun as a camera sees it, with glare round the disc, a horizontal streak and lens ghosts along the line
 * through the centre of the frame. Whether the sun is showing is read from the image itself, at the sun's position,
 * so the flare dies when a building or a hill passes in front of it.
 */
export function createGradePass(): ShaderPass & { update(camera: THREE.PerspectiveCamera, sunDirection: THREE.Vector3): void } {
  const pass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      sunPos: { value: new THREE.Vector2() },
      sunOn: { value: 0 },
      aspect: { value: 1 },
      saturation: { value: 1.16 },
      contrast: { value: 1.08 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec2 sunPos;
      uniform float sunOn;
      uniform float aspect;
      uniform float saturation;
      uniform float contrast;
      varying vec2 vUv;

      // How much of the sun's disc shows: its pixels are near white unless something stands in front of it.
      float sunVisible() {
        float v = 0.0;
        for (int i = 0; i < 5; i++) {
          float a = float(i) * 1.2566;
          vec2 o = i == 0 ? vec2(0.0) : vec2(cos(a), sin(a)) * 0.006;
          vec3 s = texture2D(tDiffuse, sunPos + o * vec2(1.0, aspect)).rgb;
          v += smoothstep(0.88, 0.98, min(s.r, min(s.g, s.b)));
        }
        return v / 5.0;
      }

      float ghost(vec2 centre, float size) {
        return smoothstep(size, size * 0.55, length((vUv - centre) * vec2(aspect, 1.0)));
      }

      void main() {
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, saturation);
        c = (c - 0.5) * contrast + 0.5;
        c += vec3(0.025, 0.012, -0.012) * smoothstep(0.55, 1.0, l);
        c += vec3(-0.008, 0.0, 0.016) * (1.0 - smoothstep(0.0, 0.35, l));

        if (sunOn > 0.0) {
          float vis = sunVisible() * sunOn;
          if (vis > 0.0) {
            vec2 d = (vUv - sunPos) * vec2(aspect, 1.0);
            float r = length(d);
            vec3 warm = vec3(1.0, 0.9, 0.74);
            vec3 flare = warm * (exp(-r * 13.0) * 0.12 + exp(-r * 34.0) * 0.4);
            flare += warm * exp(-abs(d.y) * 160.0) * exp(-abs(d.x) * 3.0) * 0.16;
            vec2 axis = vec2(0.5) - sunPos;
            flare += vec3(1.0, 0.75, 0.45) * ghost(sunPos + axis * 0.55, 0.035) * 0.1;
            flare += vec3(0.45, 0.9, 0.6) * ghost(sunPos + axis * 1.1, 0.06) * 0.07;
            flare += vec3(0.6, 0.55, 1.0) * ghost(sunPos + axis * 1.45, 0.022) * 0.12;
            flare += vec3(0.95, 0.6, 0.85) * ghost(sunPos + axis * 1.9, 0.09) * 0.05;
            c += flare * vis;
          }
        }
        gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      }`,
  }) as ShaderPass & { update(camera: THREE.PerspectiveCamera, sunDirection: THREE.Vector3): void };

  const p = new THREE.Vector3();
  const forward = new THREE.Vector3();
  pass.update = (camera, sunDirection) => {
    const u = pass.uniforms;
    u.aspect.value = camera.aspect;
    camera.getWorldDirection(forward);
    p.copy(camera.position).addScaledVector(sunDirection, 1000).project(camera);
    // Only when the sun is in front of the camera and on screen, fading out toward the edges.
    const edge = Math.max(Math.abs(p.x), Math.abs(p.y));
    u.sunOn.value = forward.dot(sunDirection) > 0 ? 1 - THREE.MathUtils.smoothstep(edge, 0.85, 0.98) : 0;
    (u.sunPos.value as THREE.Vector2).set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
  };
  return pass;
}
