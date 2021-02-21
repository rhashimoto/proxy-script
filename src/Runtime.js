// Copyright 2021 Roy T. Hashimoto. All rights reserved.
import { SourceMap } from './SourceMap.js';

// Enumerate global objects and their properties.
const IMMUTABLE = new WeakSet();
getGlobals(globalThis);

// The AsyncFunction constructor is *not* a global object but
// it needs to be marked as global to prevent mutation.
const AsyncFunction = (async () => {}).constructor;
getGlobals(AsyncFunction);

function getGlobals(obj) {
  if (obj === Object(obj) && !IMMUTABLE.has(obj)) {
    IMMUTABLE.add(obj);
    const descriptors = Object.getOwnPropertyDescriptors(obj);
    for (const [name, descriptor] of Object.entries(descriptors)) {
      try {
        if (descriptor.get) {
          getGlobals(descriptor.get);
          if (descriptor.set) {
            getGlobals(descriptor.set);
          }
        } else {
          getGlobals(obj[name]);
        }
      } catch (e) {
        console.warn('global enumeration failure', name);
      }
    }
  }
}

const BLACKLIST = new Set([
  eval,
  Function, Function.prototype.toString,
  AsyncFunction
]);

const DEFAULT_GLOBAL_CLASSES = [
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

const DEFAULT_GLOBAL_OBJECTS = [
  'console', 'Math', 'JSON'
]

const DEFAULT_GLOBAL_FUNCTIONS = [
  'atob', 'btoa', 'isFinite', 'isNaN', 'parseFloat', 'parseInt'
].filter(name => globalThis.hasOwnProperty(name));

export class Runtime {
  /** @type {Map<string, object|function>} */
  // @ts-ignore
  globals = new Map([
    [DEFAULT_GLOBAL_CLASSES, DEFAULT_GLOBAL_OBJECTS, DEFAULT_GLOBAL_FUNCTIONS]
      .flat()
      .map(name => [name, globalThis[name]]),
  ].flat());

  /** @type {Set<function>} */
  whitelist = new Set([
    DEFAULT_GLOBAL_CLASSES.map(name => getClassEntries(globalThis[name])).flat(),
    DEFAULT_GLOBAL_OBJECTS.map(name => getOwnProperties(globalThis[name])).flat(),
    DEFAULT_GLOBAL_FUNCTIONS.map(name => globalThis[name]),

    // Don't include Function constructor or toString().
    Function.prototype.call,
    Function.prototype.apply,
    Function.prototype.bind
  ].flat().filter(x => x === Object(x)));

  /**
   * @param {{code: string, map?: object}} transpiled 
   * @param {object?} thisArg
   * @param {object} args 
   * @returns {Promise}
   */
  run(transpiled, thisArg, args) {
    transpiled = Runtime.prepare(transpiled);
    const execution = new Execution(this);
    return execution.run(transpiled, thisArg, args);
  }
};

Runtime.Error = class extends Error {
  constructor(message) {
    super(message);
  }
};

const PREPARED = Symbol('prepared');
/**
 * Patch sourcemap and attach inline to code.
 * @param {{code: string, map?: object}} transpiled 
 */
Runtime.prepare = function(transpiled) {
  if (transpiled[PREPARED]) return transpiled;
  transpiled = Object.assign({}, transpiled, { [PREPARED]: true });

  // Add an inline sourcemap if possible.
  if (transpiled.map?.version === 3) {
    const map = transpiled.map = Object.assign({}, transpiled.map);

    // Patch sourcemap for insertions by Function constructor.
    map.sources = ['proxy-script'];
    SourceMap.patchMapForFunctionWrapper(map);

    // Add the sourcemap inline to the code.
    const inline = SourceMap.createInline(map);
    if (inline.length < 2 ** 23) {
      transpiled.code += `\n${inline}`;
    } else {
      console.warn(`proxy-script sourcemap omitted due to size (${inline.length} bytes)`);
    }
  }
  return transpiled;
}

const UNWRAP = Symbol('unwrap');

class Execution {
  _runtime;
  _functions = new WeakSet();
  externals = new Map();

  // All proxies are remembered in this map. This is not just an optimization;
  // it is important that the same proxy is always used for the same object.
  // Consider the case where objects are kept in a set and tested for
  // membership - that doesn't work if there can be multiple proxies.
  //
  // Proxies are mapped to themselves. Hopefully that doesn't affect garbage
  // collection.
  _mapObjectToProxy = new WeakMap();

  /**
   * @param {Runtime} runtime 
   */
  constructor(runtime) {
    this._runtime = runtime;

    // Expose Promise that works. Dynamically created functions that come
    // from external code need special handling. Here we add a subclass
    // that registers the `resolve` and `reject` functions before passing
    // them to the client code.
    const func = f => this.registerFunction(f);
    class MyPromise extends Promise {
      constructor(f) {
        super((resolve, reject) => {
          func(resolve);
          func(reject);
          f(resolve, reject);
        })
      }
    };
    this.externals.set('Promise', this.registerClass(MyPromise));
  }

  /** @type {ProxyHandler} */
  _handler = {
    get: (target, property, receiver) => {
      if (property === UNWRAP && this._mapObjectToProxy.has(receiver)) {
        return target;
      }

      // Members of a proxied object are also proxied to protect
      // them against mutation.
      const member = Reflect.get(target, property);
      this._maybeWrap(member, true);
      return member;
    },

    defineProperty() { throw new Runtime.Error('defineProperty violation'); },
    deleteProperty() { throw new Runtime.Error('deleteProperty violation'); },
    preventExtensions() { throw new Runtime.Error('preventExtensions violation'); },
    set() { throw new Runtime.Error('set violation'); },
    setPrototypeOf() { throw new Runtime.Error('setPrototypeOf violation'); },
  };
  
  /**
   * Runtime Proxy wrapper.
   * @param {object} obj 
   * @param {boolean} [skipGlobalCheck]
   * @returns {any} Proxy for a global, otherwise the argument itself.
   */
  _maybeWrap(obj, skipGlobalCheck) {
    if (obj !== Object(obj)) return obj;
    obj = obj[UNWRAP] ?? obj;

    if (BLACKLIST.has(obj)) {
      throw new Runtime.Error('blacklist violation');
    }

    // A function must either be user-defined or be on the whitelist.
    const isWhitelisted = this._runtime.whitelist.has(obj);
    if (typeof obj === 'function' && !this._functions.has(obj) && !isWhitelisted) {
      throw new Runtime.Error('whitelist violation');
    }

    if (this._mapObjectToProxy.has(obj)) {
      // This object already has a Proxy so use the existing one.
      return this._mapObjectToProxy.get(obj);
    }

    if (!skipGlobalCheck && !IMMUTABLE.has(obj)) return obj;

    const proxy = new Proxy(obj, this._handler);
    this._mapObjectToProxy.set(obj, proxy);
    this._mapObjectToProxy.set(proxy, proxy);
    return proxy;
  }
  
  /**
   * Runtime support for method invocation.
   * @param {*} object 
   * @param {*} property 
   * @param  {...any} args 
   */
  _callMethod(object, property, ...args) {
    const member = object[property];
    if (member === Function.prototype.bind) {
      // Register bind() return value as a special case.
      return this.registerFunction(member.apply(object, args));
    }
    return this._maybeWrap(member).apply(object, args);
  }

  /**
   * Enable a function to be called.
   * 
   * This is primarily used internally, but it can also be used to register
   * dynamically created functions passed to transpiled code. For example,
   * The constructor uses this to allow the Promise constructor callbacks.
   * For most functions, i.e. those that aren't generated dynamically,
   * using the Runtime whitelist instead is more appropriate.
   * @param {function} f 
   */
  registerFunction(f) {
    if (typeof f === 'function') {
      this._functions.add(f);
    }
    return f;
  }

  /**
   * Register user-defined class and methods.
   * 
   * This is primarily used internally. In most cases, class prototype
   * methods should be enabled using the Runtime whitelist.
   * @param {function} cls 
   */
  registerClass(cls) {
    const descriptors = Object.getOwnPropertyDescriptors(cls.prototype);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (typeof descriptor.get === 'function') {
        this.registerFunction(descriptor.get);
        if (typeof descriptor.set === 'function') {
          this.registerFunction(descriptor.set);
        }
      } else {
        const member = cls.prototype[key];
        if (typeof member === 'function') {
          this.registerFunction(member);
        }
      }
    }
    return this.registerFunction(cls);
  }

  /**
   * Look up external references.
   * @param {string} name 
   */
  _getExternal(name) {
    if (this.externals.has(name)) {
      return this.externals.get(name);
    }

    if (this._runtime.globals.has(name)) {
      return this._runtime.globals.get(name);
    }
    throw new Runtime.Error(`undefined '${name}'`);
  }

  /**
   * @param {{code: string, map?: object}} transpiled 
   * @param {object?} thisArg
   * @param {object?} args 
   * @returns {Promise}
   */
  async run(transpiled, thisArg, args = {}) {
    if (!transpiled[PREPARED]) {
      throw new Error('Runtime.prepare() needed');
    }

    Object.entries(args).map(([key, value]) => this.externals.set(key, value));
    const support = {
      '_wrap': this._maybeWrap.bind(this),
      '_call': this._callMethod.bind(this),
      '_func': this.registerFunction.bind(this),
      '_klass': this.registerClass.bind(this),
      '_external': this._getExternal.bind(this)
    };
    
    try {
      const f = new Function(...Object.keys(support), transpiled.code);
      return await f.call(thisArg, ...Object.values(support));
    } catch (e) {
      if (e === Object(e) && typeof e.stack === 'string') {
        e.stack = SourceMap.patchStackTrace(e.stack, transpiled.map);
      }
      throw e;
    }
  }
}

/**
 * Given a class, returns array of related items (including the class).
 * @param {function} cls 
 */
function getClassEntries(cls) {
  return [cls, getOwnProperties(cls), getOwnProperties(cls.prototype)].flat();
}

/**
 * Given an object, returns array of property values.
 * @param {object} obj 
 */
function getOwnProperties(obj) {
  const descriptors = Object.getOwnPropertyDescriptors(obj);
  return Object.entries(descriptors)
    .map(([name, descriptor]) => {
      // Return getter/setter if any exists.
      const accessors = [descriptor.get, descriptor.set].filter(f => typeof f === 'function');
      return accessors.length ? accessors : obj[name];
    })
    .flat();
}
