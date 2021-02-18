// Copyright 2021 Roy T. Hashimoto. All rights reserved.
import { SourceMap } from './SourceMap.js';

// Make sure some definitions exist.
const AsyncFunction = (async () => {}).constructor;

// Enumerate global objects and their properties.
const GLOBALS = new WeakSet();
getGlobals(globalThis);

// The AsyncFunction constructor is *not* a global object but
// it needs to be marked as global to prevent mutation.
getGlobals(AsyncFunction);

function getGlobals(obj, key) {
  if (obj === Object(obj) && !GLOBALS.has(obj)) {
    GLOBALS.add(obj);
    const descriptors = Object.getOwnPropertyDescriptors(obj);
    for (const [name, descriptor] of Object.entries(descriptors)) {
      try {
        // Skip prototype getters, which may fail and generally don't
        // return persistent objects anyway.
        if (key !== 'prototype' || !descriptor.get) {
          getGlobals(obj[name], name);
        }
      } catch (e) {
        // @ts-ignore
        if (typeof process === 'undefined') {
          // These messages are suppressed outside the browser environment.
          console.warn('global enumeration failure', name);
        }
      }
    }
  }
}

export class Runtime {
  /**
   * Whitelist functions can be called. Note that non-whitelist objects
   * (that are not on the blacklist) allow access to properties.
   * @type {Set<function|object>}
   */
  whitelist = new Set([
    [
      Array, Object, Boolean, Error,
      Number, BigInt, Date,
      String, RegExp,
      Map, Set, WeakMap, WeakSet,
      Symbol,
      Promise,

      ArrayBuffer,
      Int8Array, Int16Array, Int32Array,
      Uint8Array, Uint16Array, Uint32Array,
      Float32Array, Float64Array,
      DataView
    ].map(cls => getClassEntries(cls)).flat(),

    // Don't include Function constructor or toString().
    Function.prototype.call,
    Function.prototype.apply,
    Function.prototype.bind,

    getOwnProperties(console),
    getOwnProperties(Math),
    getOwnProperties(JSON),

    globalThis.atob, globalThis.btoa,
    globalThis.isFinite, globalThis.isNaN,
    globalThis.parseFloat, globalThis.parseInt,
    globalThis.encodeURI, globalThis.encodeURIComponent,
    globalThis.decodeURI, globalThis.decodeURIComponent
  ].flat().filter(x => x === Object(x)));

  /**
   * Blacklist objects cannot be used at all.
   * @type {Set<function|object>}
   */
  blacklist = new Set([
    globalThis.document
  ].filter(x => x === Object(x)));

  // All proxies are remembered in this map. This is not just an optimization;
  // it is important that the same proxy is always used for the same object.
  // Consider the case where objects are kept in a set and tested for
  // membership - that doesn't work if there can be multiple proxies.
  //
  // Proxies are mapped to themselves. Hopefully that doesn't affect garbage
  // collection.
  mapObjectToProxy = new WeakMap();

  /** @type {ProxyHandler} */
  handler = {
    apply: (target, thisArg, args) => {
      this.assertAccess(target, 'apply');
      return Reflect.apply(target, thisArg, args);
    },

    construct: (target, args, newTarget) => {
      this.assertAccess(target, 'construct');
      return Reflect.construct(target, args, newTarget);
    },

    get: (target, property) => {
      const member = Reflect.get(target, property);
      if (member === Object(member)) {
        // This member object has been reached via a global so it is also
        // marked as a global. This is needed to wrap objects reached via
        // getters, notably DOM objects.
        GLOBALS.add(member);
      }
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
   * @returns {any} Proxy for a global, otherwise the argument itself.
   */
  maybeWrap(obj) {
    if (obj !== Object(obj)) return obj;
    if (this.blacklist.has(obj)) throw new Runtime.Error('blacklist violation');
    if (!GLOBALS.has(obj)) return obj;

    if (this.mapObjectToProxy.has(obj)) {
      // This object already has a Proxy so use the existing one.
      return this.mapObjectToProxy.get(obj);
    }

    const proxy = new Proxy(obj, this.handler);
    this.mapObjectToProxy.set(obj, proxy);
    this.mapObjectToProxy.set(proxy, proxy);
    return proxy;
  }
  
  /**
   * Runtime support for method invocation.
   * @param {*} object 
   * @param {*} property 
   * @param  {...any} args 
   */
  call(object, property, ...args) {
    return this.maybeWrap(object[property]).apply(object, args);
  }

  assertAccess(obj, type = 'access') {
    if (GLOBALS.has(obj) && !this.whitelist.has(obj)) {
      throw new Runtime.Error(`${type} violation`);
    }
  }

  /**
   * @param {{code: string, map?: object}} transpiled 
   * @param {object?} thisArg
   * @param {object} args 
   * @returns {Promise}
   */
  async run(transpiled, thisArg, args) {
    this.whitelist.add = () => {
      throw new Error('whitelist modification after run');
    };
    this.blacklist.add(Function);
    this.blacklist.add(AsyncFunction);
    this.blacklist.add(eval);

    transpiled = Runtime.prepare(transpiled);
    args = Object.assign({}, args, {
      '_wrap': this.maybeWrap.bind(this),
      '_call': this.call.bind(this)
    });
    const f = new Function(...Object.keys(args), transpiled.code);
    try {
      return await f.call(thisArg, ...Object.values(args));
    } catch (e) {
      if (e === Object(e) && typeof e.stack === 'string') {
        e.stack = SourceMap.patchStackTrace(e.stack, transpiled.map);
      }
      throw e;
    }
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

/**
 * Update collection of global objects in case of additions to the
 * global scope after module load.
 */
Runtime.updateGlobals = () => {
  getGlobals(globalThis);
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
  return Object.getOwnPropertyNames(obj).filter(name => {
    const descriptor = Object.getOwnPropertyDescriptor(obj, name);
    return !descriptor.get;
  }).map(name => obj[name]);
}
