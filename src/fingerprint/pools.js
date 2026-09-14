// Mirage — curated data pools for consistent fingerprint generation.
// All pools are cross-linked by OS so the generator can build identities that
// survive browserleaks/pixelscan-style consistency checks.

export const CHROME_MAJORS = [136, 137, 138, 139, 140, 141, 142, 143, 144];
export const CHROME_FULLS = { // plausible full versions per major (for Sec-CH-UA-Full-Version)
  136: '136.0.7103.113', 137: '137.0.7151.70', 138: '138.0.7204.169', 139: '139.0.7258.139',
  140: '140.0.7339.203', 141: '141.0.7390.108', 142: '142.0.7444.175', 143: '143.0.7499.192', 144: '144.0.7559.133',
};
export const FIREFOX_VERSIONS = ['128.0', '129.0', '130.0', '131.0', '132.0', '133.0', '134.0', '135.0', '136.0', '138.0', '140.0.2', '141.0', '142.0'];
export const SAFARI_VERSIONS = ['16.6', '17.0', '17.2', '17.4', '17.5', '17.6', '18.0', '18.1', '18.2'];

// OS descriptors -------------------------------------------------------------
export const OSES = {
  'windows-11': { name: 'Windows 11', family: 'windows', platform: 'Win32', uaToken: 'Windows NT 10.0; Win64; x64', hintPlatform: 'Windows', touchDefault: 0, dprOptions: [1, 1, 1.25, 1.5] },
  'windows-10': { name: 'Windows 10', family: 'windows', platform: 'Win32', uaToken: 'Windows NT 10.0; Win64; x64', hintPlatform: 'Windows', touchDefault: 0, dprOptions: [1, 1, 1.25] },
  'macos-sonoma': { name: 'macOS Sonoma', family: 'mac', platform: 'MacIntel', uaToken: 'Macintosh; Intel Mac OS X 10_15_7', hintPlatform: 'macOS', touchDefault: 0, dprOptions: [2, 2, 1] },
  'macos-sequoia': { name: 'macOS Sequoia', family: 'mac', platform: 'MacIntel', uaToken: 'Macintosh; Intel Mac OS X 10_15_7', hintPlatform: 'macOS', touchDefault: 0, dprOptions: [2, 2, 1] },
  'macos-ventura': { name: 'macOS Ventura', family: 'mac', platform: 'MacIntel', uaToken: 'Macintosh; Intel Mac OS X 10_15_7', hintPlatform: 'macOS', touchDefault: 0, dprOptions: [2, 1] },
  'ubuntu-2404': { name: 'Ubuntu 24.04', family: 'linux', platform: 'Linux x86_64', uaToken: 'X11; Linux x86_64', hintPlatform: 'Linux', touchDefault: 0, dprOptions: [1, 1, 2] },
  'android-14': { name: 'Android 14', family: 'android', platform: 'Linux armv81', uaToken: 'Linux; Android 14', hintPlatform: 'Android', touchDefault: 5, mobile: true, dprOptions: [2.625, 2.75, 3] },
  'android-13': { name: 'Android 13', family: 'linux android'.split(' ')[1], platform: 'Linux armv8l', uaToken: 'Linux; Android 13', hintPlatform: 'Android', touchDefault: 5, mobile: true, dprOptions: [2.5, 2.75, 3] },
  'ios-17': { name: 'iOS 17', family: 'ios', platform: 'iPhone', uaToken: 'iPhone; CPU iPhone OS 17_5 like Mac OS X', hintPlatform: 'iOS', touchDefault: 5, mobile: true, dprOptions: [3, 2] },
  'ios-18': { name: 'iOS 18', family: 'ios', platform: 'iPhone', uaToken: 'iPhone; CPU iPhone OS 18_3 like Mac OS X', hintPlatform: 'iOS', touchDefault: 5, mobile: true, dprOptions: [3] },
};

// Browsers per OS family ------------------------------------------------------
export const BROWSERS = {
  chrome: { label: 'Chrome', vendor: 'Google Inc.' },
  edge: { label: 'Edge', vendor: 'Google Inc.' },
  firefox: { label: 'Firefox', vendor: '' },
  safari: { label: 'Safari', vendor: 'Apple Computer, Inc.' },
};

// GPU pools keyed by family ----------------------------------------------------
export const GPUS = {
  windows: [
    { vendor: 'Google Inc. (NVIDIA)', unmaskedVendor: 'NVIDIA', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)', w: 12 },
    { vendor: 'Google Inc. (NVIDIA)', unmaskedVendor: 'NVIDIA', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', w: 10 },
    { vendor: 'Google Inc. (NVIDIA)', unmaskedVendor: 'NVIDIA', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)', w: 8 },
    { vendor: 'Google Inc. (NVIDIA)', unmaskedVendor: 'NVIDIA', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)', w: 6 },
    { vendor: 'Google Inc. (Intel)', unmaskedVendor: 'Intel Inc.', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', w: 12 },
    { vendor: 'Google Inc. (Intel)', unmaskedVendor: 'Intel Inc.', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', w: 10 },
    { vendor: 'Google Inc. (Intel)', unmaskedVendor: 'Intel Inc.', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)', w: 7 },
    { vendor: 'Google Inc. (Intel)', unmaskedVendor: 'Intel Inc.', renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', w: 3 },
    { vendor: 'Google Inc. (AMD)', unmaskedVendor: 'AMD', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', w: 6 },
    { vendor: 'Google Inc. (AMD)', unmaskedVendor: 'AMD', renderer: 'ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)', w: 4 },
  ],
  mac: [
    { vendor: 'Google Inc. (Apple)', unmaskedVendor: 'Apple Inc.', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', w: 14 },
    { vendor: 'Google Inc. (Apple)', unmaskedVendor: 'Apple Inc.', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', w: 12 },
    { vendor: 'Google Inc. (Apple)', unmaskedVendor: 'Apple Inc.', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)', w: 8 },
    { vendor: 'Google Inc. (Apple)', unmaskedVendor: 'Apple Inc.', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)', w: 6 },
    { vendor: 'Google Inc. (Apple)', unmaskedVendor: 'Apple Inc.', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple G7100X, Unspecified Version)', w: 3 },
  ],
  linux: [
    { vendor: 'Google Inc. (Intel)', unmaskedVendor: 'Intel Inc.', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6)', w: 10 },
    { vendor: 'Google Inc. (Intel)', unmaskedVendor: 'Intel Inc.', renderer: 'ANGLE (Intel, Mesa Intel(R) Graphics (ADL GT2), OpenGL 4.6)', w: 8 },
    { vendor: 'Google Inc. (NVIDIA)', unmaskedVendor: 'NVIDIA', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER/PCIe/SSE2, OpenGL 4.5)', w: 6 },
    { vendor: 'Google Inc. (AMD)', unmaskedVendor: 'AMD', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi navi21 LLVM 17.0.6), OpenGL 4.5)', w: 4 },
  ],
  android: [
    { vendor: 'Google Inc. (Qualcomm)', unmaskedVendor: 'Qualcomm', renderer: 'ANGLE (Qualcomm, Adreno (TM) 740, Vulkan 1.3.0)', w: 8 },
    { vendor: 'Google Inc. (Qualcomm)', unmaskedVendor: 'Qualcomm', renderer: 'ANGLE (Qualcomm, Adreno (TM) 660, Vulkan 1.1.0)', w: 6 },
    { vendor: 'Google Inc. (ARM)', unmaskedVendor: 'ARM', renderer: 'ANGLE (ARM, Mali-G78, Vulkan 1.1.0)', w: 6 },
    { vendor: 'Google Inc. (ARM)', unmaskedVendor: 'ARM', renderer: 'ANGLE (ARM, Mali-G57, OpenGLES-2.0)', w: 4 },
  ],
  ios: [
    { vendor: 'Apple Inc.', unmaskedVendor: 'Apple Inc.', renderer: 'Apple A17 Pro GPU', w: 10 },
    { vendor: 'Apple Inc.', unmaskedVendor: 'Apple Inc.', renderer: 'Apple A15 GPU', w: 10 },
    { vendor: 'Apple Inc.', unmaskedVendor: 'Apple Inc.', renderer: 'Apple A16 GPU', w: 8 },
  ],
};
// Safari (no ANGLE) reports raw GPU names + its own extension set
export const SAFARI_MAC_GPU = ['Apple M1', 'Apple M2', 'Apple M2 Pro', 'Apple M3', 'Apple M3 Pro', 'Apple M4'];
export const SAFARI_WEBGL_EXT = ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_blend_minmax', 'EXT_canary_test', 'EXT_clip_control', 'EXT_depth_clamp', 'EXT_discard_framebuffer', 'EXT_multi_draw_arrays', 'EXT_polygon_offset_clamp', 'EXT_read_format_bgra', 'EXT_sRGB', 'EXT_shader_element_arrays', 'EXT_texture_filter_anisotropic', 'EXT_texture_mirror_clamp_to_edge', 'EXT_texture_norm16', 'WEBGL_debug_renderer_info', 'WEBGL_depth_texture', 'WEBGL_draw_buffers', 'WEBGL_lose_context', 'WEBGL_polygon_mode', 'WEBGL_shared_context_parameters', 'WEBGL_variable_compare_func', 'OES_element_index_uint', 'OES_fbo_render_mipmap', 'OES_standard_derivatives', 'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float', 'OES_texture_half_float_linear', 'OES_vertex_array_object', 'WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_etc1', 'WEBGL_compressed_texture_pvrtc'];

// Per-vendor WebGL extensions (subset pools)
export const WEBGL_BASE_EXT = ['ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_clip_control', 'EXT_color_buffer_half_float', 'EXT_depth_clamp', 'EXT_float_blend', 'EXT_frag_depth', 'EXT_polygon_offset_clamp', 'EXT_shader_texture_lod', 'EXT_texture_compression_bptc', 'EXT_texture_compression_rgtc', 'EXT_texture_filter_anisotropic', 'EXT_texture_mirror_clamp_to_edge', 'EXT_sRGB', 'KHR_parallel_shader_compile', 'OES_element_index_uint', 'OES_fbo_render_mipmap', 'OES_standard_derivatives', 'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float', 'OES_texture_half_float_linear', 'OES_vertex_array_object', 'WEBGL_blend_func_extended', 'WEBGL_color_buffer_float', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb', 'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders', 'WEBGL_depth_texture', 'WEBGL_draw_buffers', 'WEBGL_lose_context', 'WEBGL_multi_draw'];
export const WEBGL_VENDOR_EXT = {
  NVIDIA: ['WEBGL_compressed_texture_pvrtc', 'WEBGL_compressed_texture_astc', 'WEBGL_polygon_mode', 'WEBGL_shared_context_parameters'],
  'Intel Inc.': ['WEBGL_polygon_mode', 'WEBGL_multisampled_render_to_texture', 'WEBGL_compressed_texture_astc'],
  AMD: ['WEBGL_compressed_texture_astc', 'WEBGL_polygon_mode', 'WEBGL_shared_context_parameters'],
  'Apple Inc.': ['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_etc1', 'WEBGL_compressed_texture_pvrtc', 'WEBGL_multisampled_render_to_texture'],
  Qualcomm: ['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_etc1', 'WEBGL_compressed_texture_pvrtc', 'WEBGL_multisampled_render_to_texture', 'OES_vertex_array_object'],
  ARM: ['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_etc1', 'WEBGL_multisampled_render_to_texture'],
};

// Screen pools (weighted) ------------------------------------------------------
export const SCREENS = {
  windows: [
    { w: 1920, h: 1080, dpr: 1, wgt: 30 }, { w: 1366, h: 768, dpr: 1, wgt: 13 }, { w: 1536, h: 864, dpr: 1, wgt: 9 },
    { w: 2560, h: 1440, dpr: 1, wgt: 8 }, { w: 1440, h: 900, dpr: 1, wgt: 6 }, { w: 1680, h: 1050, dpr: 1, wgt: 5 },
    { w: 1600, h: 900, dpr: 1, wgt: 5 }, { w: 1920, h: 1200, dpr: 1, wgt: 4 }, { w: 3840, h: 2160, dpr: 1, wgt: 3 },
    { w: 1280, h: 720, dpr: 1, wgt: 3 }, { w: 1707, h: 964, dpr: 1.5, wgt: 4 }, { w: 1280, h: 800, dpr: 1, wgt: 3 },
    { w: 2560, h: 1600, dpr: 1, wgt: 2 }, { w: 1280, h: 960, dpr: 1, wgt: 2 },
  ],
  mac: [ // logical points (retina dpr 2 unless marked ext = external non-retina monitor)
    { w: 1440, h: 900, dpr: 2, wgt: 12 }, { w: 1280, h: 800, dpr: 2, wgt: 10 }, { w: 1512, h: 982, dpr: 2, wgt: 12 },
    { w: 1728, h: 1117, dpr: 2, wgt: 10 }, { w: 1680, h: 1050, dpr: 2, wgt: 6 }, { w: 2560, h: 1440, dpr: 2, wgt: 6 },
    { w: 1920, h: 1080, dpr: 1, ext: 1, wgt: 6 }, { w: 3456, h: 2234, dpr: 2, wgt: 4 }, { w: 1366, h: 768, dpr: 2, wgt: 5 },
    { w: 1536, h: 960, dpr: 2, wgt: 5 }, { w: 3840, h: 2160, dpr: 1, ext: 1, wgt: 3 },
  ],
  linux: [
    { w: 1920, h: 1080, dpr: 1, wgt: 16 }, { w: 2560, h: 1440, dpr: 1, wgt: 8 }, { w: 1680, h: 1050, dpr: 1, wgt: 3 },
    { w: 3440, h: 1440, dpr: 1, wgt: 2 }, { w: 1366, h: 768, dpr: 1, wgt: 6 }, { w: 3840, h: 2160, dpr: 1, wgt: 3 },
  ],
  android: [
    { w: 412, h: 915, dpr: 2.625, wgt: 12 }, { w: 393, h: 873, dpr: 2.75, wgt: 10 }, { w: 360, h: 800, dpr: 3, wgt: 9 },
    { w: 393, h: 852, dpr: 3, wgt: 8 }, { w: 411, h: 891, dpr: 2.6, wgt: 6 }, { w: 428, h: 926, dpr: 3, wgt: 5 },
  ],
  ios: [
    { w: 390, h: 844, dpr: 3, wgt: 12 }, { w: 393, h: 852, dpr: 3, wgt: 12 }, { w: 430, h: 932, dpr: 3, wgt: 8 },
    { w: 375, h: 667, dpr: 2, wgt: 5 }, { w: 414, h: 896, dpr: 2, wgt: 4 }, { w: 440, h: 956, dpr: 3, wgt: 4 },
  ],
};

// Country → timezone / language mapping ----------------------------------------
// lang: navigator.languages[0]; al: Accept-Language header; tzs: IANA zones; geo: [lat, lon] capital-ish
export const REGIONS = {
  US: { lang: 'en-US', al: 'en-US,en;q=0.9', tzs: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix'], geo: { 'America/New_York': [40.7128, -74.006], 'America/Chicago': [41.8781, -87.6298], 'America/Denver': [39.7392, -104.9903], 'America/Los_Angeles': [34.0522, -118.2437], 'America/Phoenix': [33.4484, -112.074] }, wgt: 22 },
  GB: { lang: 'en-GB', al: 'en-GB,en;q=0.9', tzs: ['Europe/London'], geo: { 'Europe/London': [51.5074, -0.1278] }, wgt: 8 },
  DE: { lang: 'de-DE', al: 'de-DE,de;q=0.9,en;q=0.8', tzs: ['Europe/Berlin'], geo: { 'Europe/Berlin': [52.52, 13.405] }, wgt: 8 },
  FR: { lang: 'fr-FR', al: 'fr-FR,fr;q=0.9,en;q=0.8', tzs: ['Europe/Paris'], geo: { 'Europe/Paris': [48.8566, 2.3522] }, wgt: 7 },
  NL: { lang: 'nl-NL', al: 'nl-NL,nl;q=0.9,en;q=0.8', tzs: ['Europe/Amsterdam'], geo: { 'Europe/Amsterdam': [52.3676, 4.9041] }, wgt: 5 },
  PL: { lang: 'pl-PL', al: 'pl-PL,pl;q=0.9,en;q=0.8', tzs: ['Europe/Warsaw'], geo: { 'Europe/Warsaw': [52.2297, 21.0122] }, wgt: 4 },
  IT: { lang: 'it-IT', al: 'it-IT,it;q=0.9,en;q=0.8', tzs: ['Europe/Rome'], geo: { 'Europe/Rome': [41.9028, 12.4964] }, wgt: 5 },
  ES: { lang: 'es-ES', al: 'es-ES,es;q=0.9,en;q=0.8', tzs: ['Europe/Madrid'], geo: { 'Europe/Madrid': [40.4168, -3.7038] }, wgt: 5 },
  BR: { lang: 'pt-BR', al: 'pt-BR,pt;q=0.9,en;q=0.8', tzs: ['America/Sao_Paulo'], geo: { 'America/Sao_Paulo': [-23.5505, -46.6333] }, wgt: 6 },
  CA: { lang: 'en-CA', al: 'en-CA,en;q=0.9', tzs: ['America/Toronto', 'America/Vancouver'], geo: { 'America/Toronto': [43.6532, -79.3832], 'America/Vancouver': [49.2827, -123.1207] }, wgt: 4 },
  AU: { lang: 'en-AU', al: 'en-AU,en;q=0.9', tzs: ['Australia/Sydney', 'Australia/Melbourne'], geo: { 'Australia/Sydney': [-33.8688, 151.2093], 'Australia/Melbourne': [-37.8136, 144.9631] }, wgt: 3 },
  IN: { lang: 'en-IN', al: 'en-IN,en;q=0.9,hi;q=0.8', tzs: ['Asia/Kolkata'], geo: { 'Asia/Kolkata': [22.5726, 88.3639] }, wgt: 4 },
  JP: { lang: 'ja-JP', al: 'ja-JP,ja;q=0.9,en;q=0.8', tzs: ['Asia/Tokyo'], geo: { 'Asia/Tokyo': [35.6762, 139.6503] }, wgt: 3 },
  KR: { lang: 'ko-KR', al: 'ko-KR,ko;q=0.9,en;q=0.8', tzs: ['Asia/Seoul'], geo: { 'Asia/Seoul': [37.5665, 126.978] }, wgt: 2 },
  UA: { lang: 'uk-UA', al: 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7', tzs: ['Europe/Kyiv'], geo: { 'Europe/Kyiv': [50.4501, 30.5234] }, wgt: 3 },
  RU: { lang: 'ru-RU', al: 'ru-RU,ru;q=0.9,en;q=0.8', tzs: ['Europe/Moscow'], geo: { 'Europe/Moscow': [55.7558, 37.6173] }, wgt: 3 },
  TR: { lang: 'tr-TR', al: 'tr-TR,tr;q=0.9,en;q=0.8', tzs: ['Europe/Istanbul'], geo: { 'Europe/Istanbul': [41.0082, 28.9784] }, wgt: 3 },
  AE: { lang: 'ar-AE', al: 'ar-AE,ar;q=0.9,en;q=0.8', tzs: ['Asia/Dubai'], geo: { 'Asia/Dubai': [25.2048, 55.2708] }, wgt: 2 },
  SA: { lang: 'ar-SA', al: 'ar-SA,ar;q=0.9,en;q=0.8', tzs: ['Asia/Riyadh'], geo: { 'Asia/Riyadh': [24.7136, 46.6753] }, wgt: 2 },
  NG: { lang: 'en-NG', al: 'en-NG,en;q=0.9', tzs: ['Africa/Lagos'], geo: { 'Africa/Lagos': [6.5244, 3.3792] }, wgt: 2 },
  ZA: { lang: 'en-ZA', al: 'en-ZA,en;q=0.9', tzs: ['Africa/Johannesburg'], geo: { 'Africa/Johannesburg': [-26.2041, 28.0473] }, wgt: 2 },
  MX: { lang: 'es-MX', al: 'es-MX,es;q=0.9,en;q=0.8', tzs: ['America/Mexico_City'], geo: { 'America/Mexico_City': [19.4326, -99.1332] }, wgt: 3 },
  AR: { lang: 'es-AR', al: 'es-AR,es;q=0.9,en;q=0.8', tzs: ['America/Argentina/Buenos_Aires'], geo: { 'America/Argentina/Buenos_Aires': [-34.6037, -58.3816] }, wgt: 2 },
  SE: { lang: 'sv-SE', al: 'sv-SE,sv;q=0.9,en;q=0.8', tzs: ['Europe/Stockholm'], geo: { 'Europe/Stockholm': [59.3293, 18.0686] }, wgt: 2 },
  CH: { lang: 'de-CH', al: 'de-CH,de;q=0.9,en;q=0.8', tzs: ['Europe/Zurich'], geo: { 'Europe/Zurich': [47.3769, 8.5417] }, wgt: 2 },
  AT: { lang: 'de-AT', al: 'de-AT,de;q=0.9,en;q=0.8', tzs: ['Europe/Vienna'], geo: { 'Europe/Vienna': [48.2082, 16.3738] }, wgt: 2 },
  BE: { lang: 'nl-BE', al: 'nl-BE,nl;q=0.9,fr;q=0.8,en;q=0.7', tzs: ['Europe/Brussels'], geo: { 'Europe/Brussels': [50.8503, 4.3517] }, wgt: 2 },
  PT: { lang: 'pt-PT', al: 'pt-PT,pt;q=0.9,en;q=0.8', tzs: ['Europe/Lisbon'], geo: { 'Europe/Lisbon': [38.7223, -9.1393] }, wgt: 2 },
  ID: { lang: 'id-ID', al: 'id-ID,id;q=0.9,en;q=0.8', tzs: ['Asia/Jakarta'], geo: { 'Asia/Jakarta': [-6.2088, 106.8456] }, wgt: 3 },
  PH: { lang: 'en-PH', al: 'en-PH,en;q=0.9,tl;q=0.8', tzs: ['Asia/Manila'], geo: { 'Asia/Manila': [14.5995, 120.9842] }, wgt: 2 },
  VN: { lang: 'vi-VN', al: 'vi-VN,vi;q=0.9,en;q=0.8', tzs: ['Asia/Ho_Chi_Minh'], geo: { 'Asia/Ho_Chi_Minh': [10.8231, 106.6297] }, wgt: 2 },
  TH: { lang: 'th-TH', al: 'th-TH,th;q=0.9,en;q=0.8', tzs: ['Asia/Bangkok'], geo: { 'Asia/Bangkok': [13.7563, 100.5018] }, wgt: 2 },
  IL: { lang: 'he-IL', al: 'he-IL,he;q=0.9,en;q=0.8', tzs: ['Asia/Jerusalem'], geo: { 'Asia/Jerusalem': [31.7683, 35.2137] }, wgt: 2 },
  RO: { lang: 'ro-RO', al: 'ro-RO,ro;q=0.9,en;q=0.8', tzs: ['Europe/Bucharest'], geo: { 'Europe/Bucharest': [44.4268, 26.1025] }, wgt: 2 },
  CZ: { lang: 'cs-CZ', al: 'cs-CZ,cs;q=0.9,en;q=0.8', tzs: ['Europe/Prague'], geo: { 'Europe/Prague': [50.0755, 14.4378] }, wgt: 2 },
  FI: { lang: 'fi-FI', al: 'fi-FI,fi;q=0.9,en;q=0.8', tzs: ['Europe/Helsinki'], geo: { 'Europe/Helsinki': [60.1699, 24.9384] }, wgt: 1 },
  DK: { lang: 'da-DK', al: 'da-DK,da;q=0.9,en;q=0.8', tzs: ['Europe/Copenhagen'], geo: { 'Europe/Copenhagen': [55.6761, 12.5683] }, wgt: 1 },
  NO: { lang: 'nb-NO', al: 'nb-NO,nb;q=0.9,en;q=0.8', tzs: ['Europe/Oslo'], geo: { 'Europe/Oslo': [59.9139, 10.7522] }, wgt: 1 },
  PE: { lang: 'es-PE', al: 'es-PE,es;q=0.9,en;q=0.8', tzs: ['America/Lima'], geo: { 'America/Lima': [-12.0464, -77.0428] }, wgt: 1 },
  CO: { lang: 'es-CO', al: 'es-CO,es;q=0.9,en;q=0.8', tzs: ['America/Bogota'], geo: { 'America/Bogota': [4.711, -74.0721] }, wgt: 1 },
  KE: { lang: 'en-KE', al: 'en-KE,en;q=0.9,sw;q=0.8', tzs: ['Africa/Nairobi'], geo: { 'Africa/Nairobi': [-1.2921, 36.8219] }, wgt: 1 },
  SG: { lang: 'en-SG', al: 'en-SG,en;q=0.9', tzs: ['Asia/Singapore'], geo: { 'Asia/Singapore': [1.3521, 103.8198] }, wgt: 2 },
  HK: { lang: 'zh-HK', al: 'zh-HK,zh;q=0.9,en;q=0.8', tzs: ['Asia/Hong_Kong'], geo: { 'Asia/Hong_Kong': [22.3193, 114.1694] }, wgt: 2 },
  MY: { lang: 'ms-MY', al: 'ms-MY,ms;q=0.9,en;q=0.8', tzs: ['Asia/Kuala_Lumpur'], geo: { 'Asia/Kuala_Lumpur': [3.139, 101.6869] }, wgt: 2 },
  EG: { lang: 'ar-EG', al: 'ar-EG,ar;q=0.9,en;q=0.8', tzs: ['Africa/Cairo'], geo: { 'Africa/Cairo': [30.0444, 31.2357] }, wgt: 2 },
};

// Fonts per OS family (realistic metric-enumeration sets) ----------------------
export const FONTS = {
  windows: ['Arial', 'Arial Black', 'Arial Narrow', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Georgia', 'Impact', 'Microsoft Sans Serif', 'Segoe UI', 'Segoe UI Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings'],
  mac: ['-apple-system', 'Andale Mono', 'Apple Braille', 'Apple Chancery', 'Apple SD Gothic Neo', 'Arial', 'Arial Black', 'Avenir', 'Avenir Next', 'Baskerville', 'Brush Script MT', 'Chalkboard SE', 'Copperplate', 'Courier', 'Didot', 'Futura', 'Geneva', 'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Hiragino Sans', 'Lucida Grande', 'Menlo', 'Monaco', 'Optima', 'Palatino', 'PingFang SC', 'Papyrus', 'San Francisco', 'Skia', 'Snell Roundhand', 'Times', 'Trattatello', 'Zapf Dingbats'],
  linux: ['C059', 'Courier 10 Pitch', 'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif', 'Dingbats', 'FreeMono', 'FreeSans', 'FreeSerif', 'Liberation Mono', 'Liberation Sans', 'Liberation Serif', 'Nimbus Mono PS', 'Nimbus Roman', 'Nimbus Sans', 'Noto Sans', 'P052', 'Standard Symbols L', 'Ubuntu', 'URW Gothic'],
  android: ['Roboto', 'Noto Sans', 'Droid Sans', 'Source Han Sans', 'SamsungOne'],
  ios: ['-apple-system', 'SF Pro Text', 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans', 'Apple Color Emoji'],
};
// extra CJK fonts sometimes present
export const FONTS_CJK = { windows: ['Malgun Gothic', 'Yu Gothic', 'MS PGothic', 'SimSun', 'Nirmala UI'], mac: ['Apple Myungjo', 'Kufi Standard K'], linux: ['Noto Sans CJK KR', 'WenQuanYi Micro Hei'] };

export const HARDWARE = {
  cores: { windows: [2, 4, 4, 6, 8, 8, 8, 10, 12, 16, 20, 24], mac: [8, 10, 10, 12, 14, 16], linux: [4, 6, 8, 8, 12, 16], android: [8, 8, 8], ios: [6, 6] },
  memory: [2, 4, 4, 8, 8, 8, 16, 16, 32], // deviceMemory caps at 8 in modern chrome (secure ctx)
  memCapChrome: 8,
};
// Safari-era pairing for consistency (macOS/Safari & iOS/Safari major match)
export const SAFARI_BY_OS = { 'macos-sequoia': ['18.0', '18.1', '18.2'], 'macos-sonoma': ['17.0', '17.2', '17.4', '17.5', '17.6'], 'macos-ventura': ['16.0', '16.1', '16.2', '16.4', '16.6'], 'ios-17': ['17.0', '17.2', '17.4', '17.5', '17.6'], 'ios-18': ['18.0', '18.1', '18.2'] };
export const IOS_TOKEN = { '17.0': '17_0', '17.2': '17_2', '17.4': '17_4', '17.5': '17_5', '17.6': '17_6', '18.0': '18_0', '18.1': '18_1', '18.2': '18_2' };

export const MEDIA_DEVICES = {
  windows: {
    audioinput: ['Microphone (Realtek(R) Audio)', 'Microphone (USB Audio Device)', 'Headset Earphone (Hands-Free)', 'Microphone (Logitech H390 USB)'],
    audiooutput: ['Speakers (Realtek(R) Audio)', 'Speakers (USB Audio Device)', 'Headphones (Sony WH-1000XM5)', 'Speakers (NVIDIA High Definition Audio)'],
    videoinput: ['Integrated Camera', 'HD Webcam', 'USB Camera', 'Logitech C270', 'HP True Vision HD Camera', 'Lenovo EasyCamera'],
  },
  mac: {
    audioinput: ['MacBook Pro Microphone', 'External Microphone', 'AirPods Pro Microphone', 'UltraFast Resampler'],
    audiooutput: ['MacBook Pro Speakers', 'External Headphones', 'AirPods Pro', 'DELL U2723QE'],
    videoinput: ['MacBook Pro Camera', 'FaceTime HD Camera', 'USB Camera'],
  },
  linux: {
    audioinput: ['Built-in Audio Analog Stereo', 'USB Microphone', 'Jabra EVOLVE 30 II'],
    audiooutput: ['Built-in Audio Digital Stereo (HDMI)', 'Built-in Audio Analog Stereo', 'Speakers'],
    videoinput: ['Integrated Camera', 'USB 2.0 Camera', 'Microsoft LifeCam'],
  },
  android: { audioinput: ['built-in mic'], audiooutput: ['built-in speaker', 'USB Headset'], videoinput: ['back camera', 'front camera'] },
  ios: { audioinput: ['built-in mic'], audiooutput: ['speaker', 'receiver', 'Bluetooth-earbud'], videoinput: ['back camera', 'front camera'] },
};

export const VOICES = {
  windows: [
    { name: 'Microsoft Zira - English (United States)', lang: 'en-US', local: true },
    { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US', local: true },
    { name: 'Microsoft Hazel Desktop - English (United Kingdom)', lang: 'en-GB', local: true },
    { name: 'Microsoft Marki Desktop - English (United States)', lang: 'en-US', local: false },
    { name: 'Google US English', lang: 'en-US', local: false },
    { name: 'Google UK English Female', lang: 'en-GB', local: false },
    { name: 'Google Deutsch', lang: 'de-DE', local: false },
    { name: 'Google 日本語', lang: 'ja-JP', local: false },
  ],
  mac: [
    { name: 'Samantha', lang: 'en-US', local: true }, { name: 'Alex', lang: 'en-US', local: true },
    { name: 'Victoria', lang: 'en-US', local: true }, { name: 'Karen', lang: 'en-AU', local: true },
    { name: 'Moira', lang: 'en-IE', local: true }, { name: 'Tessa', lang: 'en-ZA', local: true },
    { name: 'Rishi', lang: 'en-IN', local: true }, { name: 'Eddy (英语(美国))', lang: 'en-US', local: true },
    { name: 'Flo (英语(美国))', lang: 'en-US', local: true }, { name: 'Reed (英语(美国))', lang: 'en-US', local: true },
    { name: 'Alva', lang: 'sv-SE', local: true }, { name: 'Joana', lang: 'pt-PT', local: true },
    { name: 'Google UK English Male', lang: 'en-GB', local: false },
  ],
  linux: [
    { name: 'Google Deutsch', lang: 'de-DE', local: false }, { name: 'Google US English', lang: 'en-US', local: false },
    { name: 'Google UK English Female', lang: 'en-GB', local: false }, { name: 'Google UK English Male', lang: 'en-GB', local: false },
    { name: 'Google español', lang: 'es-ES', local: false }, { name: 'Google français', lang: 'fr-FR', local: false },
    { name: 'Google italiano', lang: 'it-IT', local: false }, { name: 'Google 日本語', lang: 'ja-JP', local: false },
    { name: 'Google 한국어', lang: 'ko-KR', local: false }, { name: 'Google 普通话（中国大陆）', lang: 'zh-CN', local: false },
  ],
  android: [
    { name: 'Android Locale Sounds (English, United States)', lang: 'en-US', local: true },
    { name: 'Google Deutsch', lang: 'de-DE', local: false }, { name: 'Google US English', lang: 'en-US', local: false },
    { name: 'TTS Always', lang: 'en-US', local: false },
  ],
  ios: [
    { name: 'Samantha', lang: 'en-US', local: true }, { name: 'Alex', lang: 'en-US', local: true },
    { name: 'Grandma', lang: 'en-US', local: true }, { name: 'Rocko', lang: 'en-US', local: true },
    { name: 'Bahh', lang: 'en-US', local: true }, { name: 'Bells', lang: 'en-US', local: true },
    { name: 'Dottie', lang: 'en-US', local: true }, { name: 'Karen', lang: 'en-AU', local: true },
  ],
};

// codecs (HTMLMediaElement.canPlayType) — "" | "probably" | "maybe"
export const CODECS = {
  chrome: { 'audio/mpeg': 'probably', 'audio/mp4; codecs="mp4a.40.2"': 'probably', 'audio/ogg; codecs="vorbis"': 'probably', 'audio/ogg; codecs="opus"': 'probably', 'audio/wav': 'probably', 'audio/webm; codecs="opus"': 'probably', 'video/mp4; codecs="avc1.42E01E"': 'probably', 'video/mp4; codecs="hvc1"': '', 'video/webm; codecs="vp8,vorbis"': 'probably', 'video/webm; codecs="vp9"': 'probably', 'video/ogg; codecs="theora"': '' },
  edge: { 'audio/mpeg': 'probably', 'audio/mp4; codecs="mp4a.40.2"': 'probably', 'audio/ogg; codecs="vorbis"': 'probably', 'audio/ogg; codecs="opus"': 'probably', 'audio/wav': 'probably', 'audio/webm; codecs="opus"': 'probably', 'video/mp4; codecs="avc1.42E01E"': 'probably', 'video/mp4; codecs="hvc1"': 'probably', 'video/webm; codecs="vp8,vorbis"': 'probably', 'video/webm; codecs="vp9"': 'probably', 'video/ogg; codecs="theora"': '' },
  firefox: { 'audio/mpeg': 'probably', 'audio/mp4; codecs="mp4a.40.2"': 'maybe', 'audio/ogg; codecs="vorbis"': 'probably', 'audio/ogg; codecs="opus"': 'probably', 'audio/wav': 'probably', 'audio/webm; codecs="opus"': 'probably', 'video/mp4; codecs="avc1.42E01E"': 'maybe', 'video/mp4; codecs="hvc1"': '', 'video/webm; codecs="vp8,vorbis"': 'probably', 'video/webm; codecs="vp9"': 'probably', 'video/ogg; codecs="theora"': 'probably' },
  safari: { 'audio/mpeg': 'probably', 'audio/mp4; codecs="mp4a.40.2"': 'probably', 'audio/ogg; codecs="vorbis"': '', 'audio/ogg; codecs="opus"': '', 'audio/wav': 'probably', 'audio/webm; codecs="opus"': 'maybe', 'video/mp4; codecs="avc1.42E01E"': 'probably', 'video/mp4; codecs="hvc1"': 'probably', 'video/webm; codecs="vp8,vorbis"': '', 'video/webm; codecs="vp9"': 'maybe', 'video/ogg; codecs="theora"': '' },
};

// TLS / HTTP2 profile labels (kernel-level, surfaced for honesty + future relay)
export const TLS_PROFILES = {
  chrome: { label: 'Chrome (BoringSSL)', ja3: '771,4865-4866-4867-4868-4869-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-48,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0', alpn: 'h2,http/1.1' },
  firefox: { label: 'Firefox (NSS)', ja3: '771,4865-4866-4867-4868-4869-49195-49196-49199-49200-52393-52392-49171-49172-156-157-47-48,0-23-65281-10-11-5-13-12-18-51-45-43-27-17513,29-23-24,0', alpn: 'h2,http/1.1' },
  safari: { label: 'Safari (AppleTLS)', ja3: '771,49199-49196-49195-52393-49200-49193-49194-49192-49167-49169-49172-49171-49166-49168-49165-158-157-156-61-60-53-47-35,0-11-10-16-5-35-51-43-13-45-23-27-17513,29-23-24-25,0', alpn: 'h2,http/1.1' },
};
export const HTTP2_PROFILES = {
  chrome: { label: 'Chrome HTTP/2', settings: '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p' },
  firefox: { label: 'Firefox HTTP/2', settings: '2:0;3:4096;4:131072;6:256|15728640|0|m,a,s,p' },
  safari: { label: 'Safari HTTP/2', settings: '2:0;3:100;4:2097152;9:1|65536|3|o;0;s;p' },
};

// Kernel version channel reference (used by the "real kernel" badge)
export const KERNEL_INFO_URL = 'https://www.chromestatus.com';

// Accept-Language expansion for secondary langs
export const LANG_FAMILIES = { 'en-US': ['en'], 'en-GB': ['en'], 'de-DE': ['de', 'en'], 'fr-FR': ['fr', 'en'], 'pt-BR': ['pt', 'en'], 'es-ES': ['es', 'en'], 'ru-RU': ['ru', 'en'], 'uk-UA': ['uk', 'ru', 'en'], 'ja-JP': ['ja', 'en'], 'ar-AE': ['ar', 'en'] };

export const SCREENSHOT_NOTES = 'Kernel-level fingerprints (TLS/JA3, HTTP/2) are emitted by the real browser kernel; Mirage labels them for consistency and a future TLS relay will enforce them.';
