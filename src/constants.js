export const DEFAULT_GLOBAL_CLASSES = [
  'Array', 'Object', 'Boolean', 'Error',
  'Number', 'BigInt', 'Date',
  'String', 'RegExp',
  'Map', 'Set', 'WeakMap', 'WeakSet',
  'Symbol',
  'Promise',

  'ArrayBuffer',
  'Int8Array', 'Int16Array', 'Int32Array',
  'Uint8Array', 'Uint16Array', 'Uint32Array',
  'Float32Array', 'Float64Array',
  'DataView'
];

export const DEFAULT_GLOBAL_OBJECTS = [
  'console', 'Math', 'JSON'
]

export const DEFAULT_GLOBAL_FUNCTIONS = [
  'atob', 'btoa', 'isFinite', 'isNaN', 'parseFloat', 'parseInt'
].filter(name => globalThis.hasOwnProperty(name));
