// Mirage — hardware device-model library.
// A real machine does NOT pick its GPU, CPU core-count, RAM, screen and audio clock
// independently — they are correlated by the physical device. Fingerprinting systems
// increasingly score "device-model coherence": an RTX 4070 paired with 2 cores and a
// 1024x768 panel screams synthetic. This module ships a set of plausible *whole devices*
// so one identity is internally consistent across every correlated property.
//
// Each model co-varies: gpu (vendor/renderer/extensions/limits/precision), hardware
// (cores/RAM/touch), screen (res/dpr), audio (sample-rate/buffer/latency), and the
// typical media devices a buyer of that machine would have attached.
import { WEBGL_BASE_EXT, WEBGL_VENDOR_EXT } from './pools.js';

const extFor = (vkey, extra = []) => Array.from(new Set([...WEBGL_BASE_EXT, ...(WEBGL_VENDOR_EXT[vkey] || []), ...extra])).sort();

// WebGL per-vendor GLSL float precision profile (getShaderPrecisionFormat).
const PREC = {
  nvidia: { high: { range: 127, precision: 23 }, medium: { range: 23, precision: 23 }, low: { range: 127, precision: 23 }, intHigh: { range: 31, precision: 0 }, intMedium: { range: 31, precision: 0 }, intLow: { range: 31, precision: 0 } },
  intel:  { high: { range: 127, precision: 23 }, medium: { range: 23, precision: 23 }, low: { range: 127, precision: 23 }, intHigh: { range: 31, precision: 0 }, intMedium: { range: 15, precision: 0 }, intLow: { range: 15, precision: 0 } },
  amd:    { high: { range: 127, precision: 23 }, medium: { range: 23, precision: 23 }, low: { range: 127, precision: 23 }, intHigh: { range: 31, precision: 0 }, intMedium: { range: 31, precision: 0 }, intLow: { range: 31, precision: 0 } },
  apple:  { high: { range: 127, precision: 23 }, medium: { range: 127, precision: 23 }, low: { range: 127, precision: 23 }, intHigh: { range: 31, precision: 0 }, intMedium: { range: 31, precision: 0 }, intLow: { range: 31, precision: 0 } },
  adreno: { high: { range: 127, precision: 23 }, medium: { range: 23, precision: 10 }, low: { range: 127, precision: 23 }, intHigh: { range: 31, precision: 0 }, intMedium: { range: 15, precision: 0 }, intLow: { range: 15, precision: 0 } },
  mali:   { high: { range: 127, precision: 23 }, medium: { range: 23, precision: 10 }, low: { range: 127, precision: 23 }, intHigh: { range: 31, precision: 0 }, intMedium: { range: 31, precision: 0 }, intLow: { range: 31, precision: 0 } },
};
const LIMITS = {
  nvidia: { maxTextureSize: 16384, maxCubeMapSize: 16384, maxRenderBufferSize: 32768, maxViewportDims: [32767, 32767], maxVertexAttribs: 16, maxCombinedTexUnits: 32, maxTextureImageUnits: 32, maxDrawBuffers: 8, maxAnisotropy: 16 },
  intel:  { maxTextureSize: 16384, maxCubeMapSize: 16384, maxRenderBufferSize: 32768, maxViewportDims: [16384, 16384], maxVertexAttribs: 16, maxCombinedTexUnits: 32, maxTextureImageUnits: 32, maxDrawBuffers: 8, maxAnisotropy: 16 },
  amd:    { maxTextureSize: 16384, maxCubeMapSize: 16384, maxRenderBufferSize: 32768, maxViewportDims: [32767, 32767], maxVertexAttribs: 16, maxCombinedTexUnits: 16, maxTextureImageUnits: 16, maxDrawBuffers: 8, maxAnisotropy: 16 },
  apple:  { maxTextureSize: 16384, maxCubeMapSize: 16384, maxRenderBufferSize: 8192, maxViewportDims: [8192, 8192], maxVertexAttribs: 16, maxCombinedTexUnits: 32, maxTextureImageUnits: 32, maxDrawBuffers: 4, maxAnisotropy: 16 },
  adreno: { maxTextureSize: 16384, maxCubeMapSize: 16384, maxRenderBufferSize: 16384, maxViewportDims: [8192, 8192], maxVertexAttribs: 16, maxCombinedTexUnits: 48, maxTextureImageUnits: 16, maxDrawBuffers: 4, maxAnisotropy: 8 },
  mali:   { maxTextureSize: 8192, maxCubeMapSize: 8192, maxRenderBufferSize: 8192, maxViewportDims: [8192, 8192], maxVertexAttribs: 16, maxCombinedTexUnits: 48, maxTextureImageUnits: 16, maxDrawBuffers: 4, maxAnisotropy: 8 },
};
const vendorKey = (v) => /nvidia/i.test(v) ? 'nvidia' : /intel/i.test(v) ? 'intel' : /amd|radeon/i.test(v) ? 'amd' : /apple/i.test(v) ? 'apple' : /adreno|qualcomm/i.test(v) ? 'adreno' : /mali|arm/i.test(v) ? 'mali' : 'nvidia';

// Media device sets keyed by a "machine archetype" — the cameras/mics a real buyer has.
const MEDIA = {
  winLaptop: { audioinput: ['Microphone (Realtek(R) Audio)', 'Microphone (High Definition Audio Device)', 'Stereo Mix (Realtek(R) Audio)'], audiooutput: ['Speakers (Realtek(R) Audio)', 'Headphones (Realtek(R) Audio)', 'Digital Output (Realtek(R) Audio)'], videoinput: ['Integrated Camera', 'HD Webcam', 'USB 2.0 HD UVC WebCam'] },
  winDesktop: { audioinput: ['Microphone (Realtek High Definition Audio)', 'Line In (Realtek High Definition Audio)'], audiooutput: ['Speakers (Realtek High Definition Audio)', 'Digital Output (Realtek High Definition Audio)', 'Headset Earphone (High Definition Audio Device)'], videoinput: ['USB Camera', 'Logitech C920 Pro HD Webcam'] },
  macBook: { audioinput: ['MacBook Pro Microphone', 'Microphone (Built-in)'], audiooutput: ['MacBook Pro Speakers', 'Headphones', 'External Headphones'], videoinput: ['FaceTime HD Camera', '1080p FaceTime HD Camera'] },
  macStudio: { audioinput: ['Microphone (Thunderbolt Audio)', 'Line In'], audiooutput: ['Speakers (Studio Display)', 'Headphones (Built-in)', 'DisplayPort'], videoinput: ['FaceTime HD Camera', 'Studio Display Camera'] },
  linux: { audioinput: ['Built-in Audio Analog Stereo', 'Front Microphone'], audiooutput: ['Built-in Audio Digital Stereo (HDMI)', 'Built-in Audio Analog Stereo'], videoinput: ['Integrated Camera', 'USB Camera'] },
  androidPixel: { audioinput: ['Pixel 8 Pro Microphone', 'Bluetooth SCO Headset Mic'], audiooutput: ['Pixel 8 Pro Speaker', 'Bluetooth SCO Headset'], videoinput: ['Camera 1 (back)', 'Camera 2 (front)', 'Camera 3 (ultra-wide)'] },
  androidSamsung: { audioinput: ['Built-in Microphone', 'Bluetooth SCO Headset Mic'], audiooutput: ['Speakerphone', 'Bluetooth SCO Headset'], videoinput: ['Camera 1', 'Camera 2 (front)', 'Camera 3'] },
  iosIphone: { audioinput: ['iPhone Microphone', 'Bluetooth-WH-1000XM4'], audiooutput: ['iPhone Speaker', 'iPhone Earpiece', 'Bluetooth-WH-1000XM4'], videoinput: ['Back Ultra Wide Camera', 'Rear Dual Camera', 'Front TrueDepth Camera'] },
};

// ---- whole-device models. family = which OS they realistically run. ----
export const MODELS = [
  // Windows — gaming / workstation laptops
  { id: 'win-rtx4060-laptop', family: 'windows', wgt: 14,
    gpu: { vendor: 'Google Inc. (NVIDIA)', unmaskedVendor: 'NVIDIA', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    hardware: { hardwareConcurrency: 12, deviceMemory: 8 }, screen: { w: 1920, h: 1080, dpr: 1 }, audio: { sampleRate: 48000, baseLatency: 0.01, outputLatency: 0.02 }, media: 'winLaptop' },
  { id: 'win-rtx3060-desktop', family: 'windows', wgt: 11,
    gpu: { vendor: 'Google Inc. (NVIDIA)', unmaskedVendor: 'NVIDIA', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    hardware: { hardwareConcurrency: 16, deviceMemory: 8 }, screen: { w: 2560, h: 1440, dpr: 1 }, audio: { sampleRate: 48000, baseLatency: 0.005, outputLatency: 0.01 }, media: 'winDesktop' },
  { id: 'win-irisxe-ultrabook', family: 'windows', wgt: 13,
    gpu: { vendor: 'Google Inc. (Intel)', unmaskedVendor: 'Intel Inc.', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    hardware: { hardwareConcurrency: 8, deviceMemory: 8 }, screen: { w: 1920, h: 1200, dpr: 1.5 }, audio: { sampleRate: 48000, baseLatency: 0.02, outputLatency: 0.04 }, media: 'winLaptop' },
  { id: 'win-uhd630-office', family: 'windows', wgt: 12,
    gpu: { vendor: 'Google Inc. (Intel)', unmaskedVendor: 'Intel Inc.', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    hardware: { hardwareConcurrency: 8, deviceMemory: 8 }, screen: { w: 1920, h: 1080, dpr: 1 }, audio: { sampleRate: 48000, baseLatency: 0.015, outputLatency: 0.03 }, media: 'winDesktop' },
  { id: 'win-rx7600', family: 'windows', wgt: 6,
    gpu: { vendor: 'Google Inc. (AMD)', unmaskedVendor: 'AMD', renderer: 'ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    hardware: { hardwareConcurrency: 16, deviceMemory: 8 }, screen: { w: 2560, h: 1080, dpr: 1 }, audio: { sampleRate: 48000, baseLatency: 0.008, outputLatency: 0.015 }, media: 'winDesktop' },
  // macOS
  { id: 'mac-m2-air', family: 'mac', wgt: 13,
    gpu: { vendor: 'Google Inc. (Apple)', unmaskedVendor: 'Apple Inc.', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
    hardware: { hardwareConcurrency: 8, deviceMemory: 8 }, screen: { w: 1440, h: 900, dpr: 2 }, audio: { sampleRate: 48000, baseLatency: 0.0053, outputLatency: 0.0375 }, media: 'macBook' },
  { id: 'mac-m3-pro', family: 'mac', wgt: 11,
    gpu: { vendor: 'Google Inc. (Apple)', unmaskedVendor: 'Apple Inc.', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)' },
    hardware: { hardwareConcurrency: 12, deviceMemory: 8 }, screen: { w: 1512, h: 982, dpr: 2 }, audio: { sampleRate: 48000, baseLatency: 0.0053, outputLatency: 0.0375 }, media: 'macBook' },
  { id: 'mac-m1-retina', family: 'mac', wgt: 9,
    gpu: { vendor: 'Google Inc. (Apple)', unmaskedVendor: 'Apple Inc.', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
    hardware: { hardwareConcurrency: 8, deviceMemory: 8 }, screen: { w: 1680, h: 1050, dpr: 2 }, audio: { sampleRate: 48000, baseLatency: 0.0058, outputLatency: 0.0348 }, media: 'macBook' },
  { id: 'mac-studio-m4', family: 'mac', wgt: 5,
    gpu: { vendor: 'Google Inc. (Apple)', unmaskedVendor: 'Apple Inc.', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)' },
    hardware: { hardwareConcurrency: 10, deviceMemory: 8 }, screen: { w: 2560, h: 1440, dpr: 2 }, audio: { sampleRate: 48000, baseLatency: 0.005, outputLatency: 0.02 }, media: 'macStudio' },
  // Linux
  { id: 'linux-uhd-mesa', family: 'linux', wgt: 8,
    gpu: { vendor: 'Google Inc. (Intel)', unmaskedVendor: 'Intel Inc.', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6)' },
    hardware: { hardwareConcurrency: 8, deviceMemory: 8 }, screen: { w: 1920, h: 1080, dpr: 1 }, audio: { sampleRate: 48000, baseLatency: 0.021, outputLatency: 0.042 }, media: 'linux' },
  { id: 'linux-nvidia-gtx1660', family: 'linux', wgt: 5,
    gpu: { vendor: 'Google Inc. (NVIDIA)', unmaskedVendor: 'NVIDIA', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER/PCIe/SSE2, OpenGL 4.5)' },
    hardware: { hardwareConcurrency: 12, deviceMemory: 8 }, screen: { w: 2560, h: 1440, dpr: 1 }, audio: { sampleRate: 48000, baseLatency: 0.01, outputLatency: 0.02 }, media: 'linux' },
  // Android (mobile touch points > 0)
  { id: 'android-pixel8pro', family: 'android', wgt: 10,
    gpu: { vendor: 'Google Inc. (Qualcomm)', unmaskedVendor: 'Qualcomm', renderer: 'ANGLE (Qualcomm, Adreno (TM) 740, Vulkan 1.3.0)' },
    hardware: { hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 5 }, screen: { w: 412, h: 892, dpr: 2.6 }, audio: { sampleRate: 48000, baseLatency: 0.037, outputLatency: 0.074 }, media: 'androidPixel' },
  { id: 'android-s23', family: 'android', wgt: 8,
    gpu: { vendor: 'Google Inc. (ARM)', unmaskedVendor: 'ARM', renderer: 'ANGLE (ARM, Mali-G78, Vulkan 1.1.0)' },
    hardware: { hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 5 }, screen: { w: 412, h: 892, dpr: 2.75 }, audio: { sampleRate: 48000, baseLatency: 0.034, outputLatency: 0.068 }, media: 'androidSamsung' },
  // iOS (Safari/WebKit → no ANGLE prefix, no WebGL2)
  { id: 'ios-15promax-a17', family: 'ios', wgt: 10, safari: true,
    gpu: { vendor: 'Apple Inc.', unmaskedVendor: 'Apple Inc.', renderer: 'Apple A17 Pro GPU', safari: true },
    hardware: { hardwareConcurrency: 6, deviceMemory: null, maxTouchPoints: 5 }, screen: { w: 430, h: 932, dpr: 3 }, audio: { sampleRate: 48000, baseLatency: 0.023, outputLatency: 0.047 }, media: 'iosIphone' },
  { id: 'ios-14pro-a16', family: 'ios', wgt: 8, safari: true,
    gpu: { vendor: 'Apple Inc.', unmaskedVendor: 'Apple Inc.', renderer: 'Apple A16 GPU', safari: true },
    hardware: { hardwareConcurrency: 6, deviceMemory: null, maxTouchPoints: 5 }, screen: { w: 393, h: 852, dpr: 3 }, audio: { sampleRate: 48000, baseLatency: 0.023, outputLatency: 0.047 }, media: 'iosIphone' },
];

export function modelsFor(family) { return MODELS.filter(m => m.family === family); }
export function modelById(id) { return MODELS.find(m => m.id === id) || null; }

// Expand a raw model into a fully-coherent fingerprint fragment.
export function expandModel(m, rng, browser) {
  const vk = vendorKey(m.gpu.unmaskedVendor);
  const isSafariGpu = !!m.gpu.safari || browser === 'safari';
  const extensions = isSafariGpu
    ? (SAFARI_EXT)
    : extFor(m.gpu.unmaskedVendor.includes('Intel') ? 'Intel Inc.' : m.gpu.unmaskedVendor.includes('AMD') ? 'AMD' : m.gpu.unmaskedVendor.includes('Apple') ? 'Apple Inc.' : m.gpu.unmaskedVendor.includes('Qualcomm') ? 'Qualcomm' : m.gpu.unmaskedVendor.includes('ARM') ? 'ARM' : 'NVIDIA');
  const webgl2 = !isSafariGpu;
  const gpu = {
    vendor: m.gpu.vendor, unmaskedVendor: m.gpu.unmaskedVendor,
    renderer: m.gpu.renderer, unmaskedRenderer: m.gpu.renderer,
    webglVersion: isSafariGpu ? 'WebGL 2.0' : 'WebGL 2.0 (OpenGL ES 3.0)',
    shadingLanguageVersion: isSafariGpu ? 'WebGL GLSL ES 1.0' : 'WebGL GLSL ES 3.00',
    webgl2, extensions, limits: LIMITS[vk], precision: PREC[vk], vendorKey: vk,
  };
  if (browser === 'chrome' || browser === 'edge') {
    const wv = vk === 'apple' ? 'apple' : vk === 'nvidia' ? 'nvidia' : vk === 'intel' ? 'intel' : vk === 'amd' ? 'amd' : vk === 'adreno' ? 'qualcomm' : 'arm';
    const devName = { nvidia: 'NVIDIA GeForce RTX 4070', intel: 'Intel(R) Iris(R) Xe Graphics', amd: 'AMD Radeon RX 7600', apple: ['Apple M1', 'Apple M2', 'Apple M3 Pro'][rng.int(0, 2)], qualcomm: 'Adreno (TM) 740', arm: 'Mali-G78' }[wv];
    if (!isSafariGpu && wv !== 'qualcomm' && wv !== 'arm') gpu.webgpu = { vendor: wv === 'intel' ? 'intel' : wv, device: devName, architecture: wv === 'apple' ? 'unknown' : 'generic' };
  }
  return {
    model: m.id, gpu,
    hardware: { hardwareConcurrency: m.hardware.hardwareConcurrency, deviceMemory: m.hardware.deviceMemory ?? null, maxTouchPoints: m.hardware.maxTouchPoints ?? 0 },
    screenBox: { width: m.screen.w, height: m.screen.h, dpr: m.screen.dpr },
    audio: { sampleRate: m.audio.sampleRate, baseLatency: m.audio.baseLatency, outputLatency: m.audio.outputLatency, maxChannelCount: 2 },
    mediaArchetype: m.media,
  };
}
const SAFARI_EXT = ['ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_clip_cull_distance', 'EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_disjoint_timer_query_webgl2', 'EXT_float_blend', 'EXT_frag_depth', 'EXT_texture_filter_anisotropic', 'EXT_sRGB', 'OES_element_index_uint', 'OES_fbo_render_mipmap', 'OES_standard_derivatives', 'OES_texture_float', 'OES_texture_half_float', 'OES_texture_half_float_linear', 'OES_vertex_array_object', 'WEBGL_color_buffer_float', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb', 'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders', 'WEBGL_depth_texture', 'WEBGL_draw_buffers', 'WEBGL_lose_context', 'WEBGL_multi_draw'];

export { MEDIA as MODEL_MEDIA };
