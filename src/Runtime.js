// Copyright 2021 Roy T. Hashimoto. All rights reserved.
import { SourceMap } from './SourceMap.js';
import {
  DEFAULT_GLOBAL_CLASSES,
  DEFAULT_GLOBAL_FUNCTIONS,
  DEFAULT_GLOBAL_OBJECTS
} from './constants.js';

// Enumerate global objects and their properties.
const IMMUTABLES = new WeakSet();
getImmutables(globalThis);

// The AsyncFunction constructor is *not* a global object but
// it needs to be marked as global to prevent mutation.
const AsyncFunction = (async () => {}).constructor;
getImmutables(AsyncFunction);

function getImmutables(obj) {
  if (obj === Object(obj) && !IMMUTABLES.has(obj)) {
    IMMUTABLES.add(obj);
    const descriptors = Object.getOwnPropertyDescriptors(obj);
    for (const [name, descriptor] of Object.entries(descriptors)) {
      try {
        if (descriptor.get) {
          getImmutables(descriptor.get);
          if (descriptor.set) {
            getImmutables(descriptor.set);
          }
        } else {
          getImmutables(obj[name]);
        }
      } catch (e) {
        console.warn('global enumeration failure', name);
      }
    }
  }
}

const ALLOWED = Symbol('allowed');
const PREPARED = Symbol('prepared');
const UNWRAP = Symbol('unwrap');

// For safety, forbid these objects even if the user whitelists them.
const BLACKLIST = new Set([
  AsyncFunction,
  Function, Function.prototype.toString,
  eval,
  setTimeout, setInterval
]);

export class Runtime {
  /** @type {Set<function>} callable global scope functions */
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
   * @param {{code: string, externals: object, map?: object}} transpiled 
   * @param {object?} externals 
   * @returns {Promise}
   */
  async run(transpiled, externals = {}) {
    transpiled = this._prepare(transpiled);

    // Check that all external references are satisfied.
    for (const external of transpiled.externals.keys()) {
      if (!externals.hasOwnProperty(external)) {
        throw new Runtime.Error(`'${external}' not provided`);
      }
    }

    // All proxies are remembered in this map. This is not just an
    // optimization; it is important that the same proxy is always used
    // for the same object.
    const mapObjectToProxy = new WeakMap();
    const support = {
      'Promise': RuntimePromise,

      '_wrap': obj => this._maybeWrap(obj, mapObjectToProxy),

      '_call': (obj, property, ...args) => {
        const member = this._maybeWrap(obj[property], mapObjectToProxy);
        return this._callMethod(obj, member, ...args);
      },

      '_func': Runtime.fn,
      '_klass': Runtime.cls
    };
    
    try {
      const f = new Function(
        ...Object.keys(support),
        ...Object.keys(externals),
        transpiled.code);
      return await f(
        ...Object.values(support),
        ...Object.values(externals));
    } catch (e) {
      if (e === Object(e) && typeof e.stack === 'string') {
        e.stack = SourceMap.patchStackTrace(e.stack, transpiled.map);
      }
      throw e;
    }
  }

  /**
   * Prepare transpiled code to be run.
   * @param {{code: string, externals: object, map?: object}} transpiled 
   */
  _prepare(transpiled) {
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
   * Wrap object with immutable Proxy if needed.
   * @param {object} obj 
   * @param {WeakMap} mapObjectToProxy
   * @param {boolean} [isImmutableProperty]
   * @returns {any} Proxy for a global, otherwise the argument itself.
   */
  _maybeWrap(obj, mapObjectToProxy, isImmutableProperty) {
    if (obj !== Object(obj)) return obj;
    if (mapObjectToProxy.has(obj)) {
      // This object already has a Proxy so use the existing one.
      return mapObjectToProxy.get(obj);
    }
    obj = obj[UNWRAP] ?? obj;

    if (BLACKLIST.has(obj)) {
      throw new Runtime.Error('blacklist violation');
    }

    // A function must either be user-defined or be on the whitelist.
    if (typeof obj === 'function' && !obj[ALLOWED] && !this.whitelist.has(obj)) {
      throw new Runtime.Error('permission denied');
    }

    if (!isImmutableProperty && !IMMUTABLES.has(obj)) return obj;

    const proxy = new Proxy(obj, {
      get: (target, property, receiver) => {
        // Use a special "property" to unwrap the proxied object. The
        // second conditional checking that the receiver is really a
        // proxy is needed to skip the case when the receiver is a subclass
        // of a proxied class.
        if (property === UNWRAP && mapObjectToProxy.has(receiver)) {
          return target;
        }

        // Members of a proxied object are also proxied to protect
        // them against mutation. The proxy is not returned here because
        // in some cases not returning the actual value throws an error,
        // but the creation of the proxy ensures its future use.
        const member = Reflect.get(target, property);
        this._maybeWrap(member, mapObjectToProxy, true);
        return member;
      },

      set: (target, property, value, receiver) => {
        if (!mapObjectToProxy.has(receiver)) {
          // Suppose a script does obj.name = "jen", and obj is not a
          // proxy, and has no own property .name, but it has a proxy on
          // its prototype chain. That proxy's set() handler will be
          // called, and obj will be passed as the receiver.
          // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/Proxy/set
          return Reflect.set(target, property, value, receiver);
        }
        throw new Runtime.Error('set violation');
      },

      defineProperty() { throw new Runtime.Error('defineProperty violation'); },
      deleteProperty() { throw new Runtime.Error('deleteProperty violation'); },
      preventExtensions() { throw new Runtime.Error('preventExtensions violation'); },
      setPrototypeOf() { throw new Runtime.Error('setPrototypeOf violation'); },
    });
    
    mapObjectToProxy.set(obj, proxy);
    mapObjectToProxy.set(proxy, proxy);
    return proxy;
  }
  
  /**
   * Runtime support for method invocation.
   * @param {*} obj 
   * @param {function} method 
   * @param {...any} args 
   */
  _callMethod(obj, method, ...args) {
    if ((method[UNWRAP] || method) === Function.prototype.bind) {
      // Register bind() return value as a special case.
      return Runtime.fn(method.apply(obj, args));
    }
    return method.apply(obj, args);
  }
};

Runtime.Error = class extends Error {
  constructor(message) {
    super(message);
  }
};

/**
 * Return a Proxy for the function argument that is allowed to be called.
 * @param {function} f 
 */
Runtime.fn = function(f) {
  if (f[ALLOWED]) return f;
  return new Proxy(f, {
    get: (target, property) => {
      if (property === ALLOWED) return true;
      return Reflect.get(target, property);
    }
  });
}

Runtime.cls = function(cls) {
  const descriptors = Object.getOwnPropertyDescriptors(cls.prototype);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (typeof descriptor.get === 'function') {
      // @ts-ignore
      descriptor.get = Runtime.fn(descriptor.get);
      if (typeof descriptor.set === 'function') {
        // @ts-ignore
        descriptor.set = Runtime.fn(descriptor.set);
      }
      Object.defineProperty(cls.prototype, key, descriptor);
    } else if (key !== 'constructor') {
      const member = cls.prototype[key];
      if (typeof member === 'function') {
        cls.prototype[key] = Runtime.fn(member);
      }
    }
  }
  return Runtime.fn(cls);
}

// Expose Promise that works. Dynamically created functions that come
// from external code need special handling. Here we add a subclass
// that registers the `resolve` and `reject` functions before passing
// them to the client code.
const RuntimePromise = Runtime.fn(Object.freeze(class extends Promise {
  constructor(f) {
    super((resolve, reject) => {
      f(Runtime.fn(resolve), Runtime.fn(reject));
    });
  }
}));

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
