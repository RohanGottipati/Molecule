import { useEffect, useRef, useState } from "react";
import type { VoiceSnapshot, VoiceState } from "../services/realtime-client.js";

const ringColor: Partial<Record<VoiceState, string>> = {
  requesting_permission: "#dcaa6b",
  connecting: "#dcaa6b",
  reconnecting: "#dcaa6b",
  listening: "#6ee7b7",
  speech_detected: "#6ee7b7",
  transcribing: "#6ee7b7",
  processing: "#dcaa6b",
  speaking: "#6ee7b7",
  error: "#ff8d87",
};

/** Seconds per full lap of the glow — mapped to angular speed for the shader. */
const spinSeconds: Partial<Record<VoiceState, number>> = {
  requesting_permission: 2.6,
  connecting: 2.6,
  reconnecting: 2.6,
  listening: 6,
  speech_detected: 3.2,
  transcribing: 3.2,
  processing: 1.3,
  speaking: 3,
};

const VERTEX_SRC = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// A dark sphere shaded by hand (no lights/textures) with a single glowing
// crescent that sweeps around it. uRotation/uClock are advanced in JS so the
// motion can be paused cleanly for reduced-motion or a frozen error state.
const FRAGMENT_SRC = `
precision highp float;
varying vec2 vUv;
uniform float uClock;
uniform float uRotation;
uniform vec3 uColor;
uniform float uPulse;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec2 uv = vUv * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;

  vec2 hc = vec2(-0.36, 0.30);
  float hd = length(uv - hc);
  float highlight = smoothstep(1.35, 0.0, hd);

  vec3 dark = vec3(0.0627, 0.0588, 0.0549);
  vec3 mid  = vec3(0.1373, 0.1333, 0.1255);
  vec3 lit  = vec3(0.2706, 0.2667, 0.2431);
  vec3 base = mix(dark, mid, smoothstep(0.0, 0.9, 1.0 - hd));
  base = mix(base, lit, highlight * 0.9);

  float breathe = 0.5 + 0.5 * sin(uClock * 0.6);
  base += lit * 0.05 * breathe * highlight;

  float rim = smoothstep(0.72, 1.0, r);
  base *= mix(1.0, 0.55, rim);
  float topLight = smoothstep(0.55, 1.0, r) * max(uv.y, 0.0) * 0.07;
  base += vec3(topLight);

  base += (hash(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0) * 1.5;

  float angle = atan(uv.y, uv.x);
  float c = cos(angle - uRotation);
  float envelope = smoothstep(-0.79, 1.0, c);
  float peak = smoothstep(0.15, 0.9, c);

  float ringRadius = 0.64;
  float bandCore = 1.0 - smoothstep(0.0, 0.05, abs(r - ringRadius));
  float bandGlow = 1.0 - smoothstep(0.0, 0.24, abs(r - ringRadius));

  float pulseWave = mix(1.0, 0.55 + 0.45 * sin(uClock * 7.5), uPulse);

  float coreIntensity = bandCore * envelope * pulseWave;
  float glowIntensity = bandGlow * envelope * 0.55 * pulseWave;

  vec3 ringCol = mix(uColor * 0.45, uColor, peak);

  vec3 color = base;
  color += uColor * glowIntensity * 0.85;
  color += ringCol * coreIntensity * 1.5;

  gl_FragColor = vec4(color, 1.0);
}
`;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`voice-orb shader failed to compile: ${info}`);
  }
  return shader;
}

interface OrbUniforms {
  clock: WebGLUniformLocation | null;
  rotation: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
  pulse: WebGLUniformLocation | null;
}

/**
 * Idle look was designed in Paper to match a reference orb: a dark sphere
 * with a soft crescent of light. Rendered with a tiny WebGL fragment shader
 * (rather than CSS masks) so the glow can sweep around continuously and
 * react to voice state without repainting layout.
 */
export function VoiceOrb({
  state,
  size = 34,
}: {
  state: VoiceSnapshot;
  size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(false);
  const live = useRef({
    color: [1, 1, 1] as [number, number, number],
    pulse: 0,
    speed: (2 * Math.PI) / 9,
    frozen: false,
  });

  const color = state.muted ? "#aaa99f" : (ringColor[state.state] ?? "#f1efe8");
  const pulse = state.state === "processing" ? 1 : 0;
  const seconds = state.muted ? 9 : (spinSeconds[state.state] ?? 9);
  const frozen = state.state === "error";
  live.current.color = hexToRgb(color);
  live.current.pulse = pulse;
  live.current.speed = (2 * Math.PI) / seconds;
  live.current.frozen = frozen;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: true,
      premultipliedAlpha: false,
    });
    if (!gl) {
      setFallback(true);
      return;
    }

    const program = gl.createProgram()!;
    try {
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SRC));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC));
    } catch (error) {
      console.error(error);
      setFallback(true);
      return;
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(
        "voice-orb program link failed",
        gl.getProgramInfoLog(program),
      );
      setFallback(true);
      return;
    }
    gl.useProgram(program);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const aPosition = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    const uniforms: OrbUniforms = {
      clock: gl.getUniformLocation(program, "uClock"),
      rotation: gl.getUniformLocation(program, "uRotation"),
      color: gl.getUniformLocation(program, "uColor"),
      pulse: gl.getUniformLocation(program, "uPulse"),
    };

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let raf = 0;
    let clock = 0;
    let rotation = 0;
    let last = performance.now();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const cssSize = canvas.clientWidth || size;
      const px = Math.max(1, Math.round(cssSize * dpr));
      if (canvas.width !== px || canvas.height !== px) {
        canvas.width = px;
        canvas.height = px;
        gl.viewport(0, 0, px, px);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const moving = !reduceMotion.matches;
      if (moving) {
        clock += dt;
        if (!live.current.frozen) rotation += dt * live.current.speed;
      }
      gl.uniform1f(uniforms.clock, clock);
      gl.uniform1f(uniforms.rotation, rotation);
      gl.uniform1f(uniforms.pulse, live.current.pulse);
      gl.uniform3f(uniforms.color, ...live.current.color);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      gl.deleteProgram(program);
      gl.deleteBuffer(quad);
    };
    // Uniform values are pushed from the `live` ref each frame; only the
    // canvas identity should retrigger setup.
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className="voice-orb"
      aria-hidden="true"
      data-fallback={fallback || undefined}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        display: "block",
        filter: `drop-shadow(0 0 ${Math.round(size * 0.16)}px ${color}4d)`,
        // Static sphere with the same crescent when WebGL is unavailable.
        background: fallback
          ? `radial-gradient(circle at 32% 30%, ${color}b3 0%, ${color}33 22%, #15151a 48%, #050506 100%)`
          : undefined,
      }}
    />
  );
}
