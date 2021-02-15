const NO_WRAP_NEEDED = new Set([
  // These types cannot be wrapped with a Proxy. This is only an
  // optimization as the wrapper checks for this.
  'BigIntLiteral',
  'BooleanLiteral',
  'DecimalLiteral',
  'NullLiteral',
  'NumericLiteral',
  'StringLiteral',
  'TemplateLiteral',

  // These types return one of their sub-expressions. This is only
  // an optimization as wrapping a proxy always returns the original
  // proxy.
  'ConditionalExpression',
  'LogicalExpression',
  'ParenthesizedExpression',
  'SequenceExpression',

  // `super` is a keyword and isn't valid inside a wrapper. This seems
  // dangerous because of the possibility of subclassing Function. However,
  // in `class Foo extends Bar...`, `Bar` will be wrapped and so the
  // constructor call will be whitelist checked.
  'Super'
]);

function plugin({ types, template }, options) {
  const bindings = Object.assign({
    wrap: '_w' + createRandomString(),
    call: '_c' + createRandomString()
  }, options.bindings);
 
  // All object expressions are wrapped by a Proxy to prevent them from
  // changing global state. Give the wrapping function a random alias so
  // it can't be shadowed.
  const wrap = template.expression(`${bindings.wrap}(NODE)`, {
    placeholderPattern: /^NODE$/
  });

  // Use a helper function for method calls, both for proper binding and
  // to handle Function.prototype.{call, apply}.
  const call = template.expression(`${bindings.call}(OBJECT, PROPERTY, ARGS)`, {
    placeholderPattern: /^(OBJECT|PROPERTY|ARGS)$/
   });

  // Wrap the entire script in an Immediately Invoked Function Expression
  // to enable await and establish the wrapping function alias.
  const iife = template.statements(`
    "use strict";
    ${
      Object.entries(bindings).map(([key, value]) => `const ${value} = _${key};`).join('\n')
    }
    return (async () => {
      BODY
    })();
  `, {
    placeholderPattern: /^BODY$/
  });

  const checkedForWrap = Symbol('checkedForWrap');
  return {
    visitor: {
      Program(path) {
        path.node.body = iife({ BODY: path.node.body });
      },

      // Wrap all Objects with a Proxy at runtime.
      Expression(path) {
        if (!path.node.loc) return;
        if (path.node[checkedForWrap]) return;
        path.node[checkedForWrap] = true;

        // Don't wrap types that either aren't Objects or are guaranteed
        // to already be wrapped (e.g. ParenthesizedExpression).
        if (NO_WRAP_NEEDED.has(path.node.type)) return;

        // Don't wrap lvalues.
        if (path.parentPath.isAssignmentExpression({ left: path.node }) ||
            path.parentPath.isUnaryExpression({ operator: 'delete' }) ||
            path.parentPath.isUpdateExpression()) {
          return;
        }

        // Don't bother wrapping an expression whose value is discarded.
        if (path.parentPath.isExpressionStatement({ expression: path.node })) return;

        path.replaceWith(wrap({ NODE: path.node }));
      },

      // Use helper function for method calls.
      CallExpression(path) {
        if (!path.node.loc) return;

        if (path.get('callee').isMemberExpression()) {
          const callee = path.node.callee;
          path.replaceWith(call({
            OBJECT: callee.object,
            PROPERTY: callee.computed ? callee.property : `'${callee.property.name}'`,
            ARGS: path.node.arguments
          }));
        }
      }
    }
  }
}

class Transpiler {
  babel = globalThis.Babel;
  babelOptions = {
    parserOpts: {
      strictMode: true,
      allowReturnOutsideFunction: true
    },
    plugins: ['syntax-top-level-await'],
    sourceMaps: true
  };

  /**
   * @param {{ bindings?: object }} [options] 
   */
  constructor(options = {}) {
    // Configure the transpiler plugin.
    Object.assign({}, options);
    // @ts-ignore
    this.babelOptions.plugins.push(['proxy-script', options]);
  }

  /**
   * @param {string} source 
   * @returns {object}
   */
  transpile(source) {
    return this.babel.transform(source, this.babelOptions);
  }
}
Transpiler.register = function(babel) {
  babel.registerPlugin('proxy-script', plugin);
};

function createRandomString() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
}

// Make sure some definitions exist.
// @ts-ignore
const btoa = globalThis.btoa ?? (s => Buffer.from(s).toString('base64'));
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

// Determine number of lines inserted by Function constructor. We need
// this information to patch the sourcemap for browser Dev Tools, and
// it varies with the Javascript implementation.
const SOURCEMAP_OFFSET = (function() {
  const lines = new Function('debugger').toString().split('\n');
  return lines.findIndex(line => line.includes('debugger'));
})();

// Transpiler output is post-processed so its sourcemaps work properly.
// Post-processed output is tagged with this Symbol.
const PREPARED = Symbol('prepared');

class Runtime {
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
      // https://stackoverflow.com/a/49739161/1462337
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

    defineProperty() { throw new Error('proxy-script defineProperty violation'); },
    deleteProperty() { throw new Error('proxy-script deleteProperty violation'); },
    preventExtensions() { throw new Error('proxy-script preventExtensions violation'); },
    set() { throw new Error('proxy-script set violation'); },
    setPrototypeOf() { throw new Error('proxy-script setPrototypeOf violation'); },
  };
  
  /**
   * Runtime Proxy wrapper.
   * @param {object} obj 
   * @returns {any} Proxy for a global, otherwise the argument itself.
   */
  maybeWrap(obj) {
    if (obj !== Object(obj)) return obj;
    if (this.blacklist.has(obj)) throw new Error('proxy-script blacklist violation');
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
      throw new Error(`proxy-script ${type} violation`);
    }
  }

  /**
   * @param {{code: string, map?: object}} transpiled 
   */
  prepare(transpiled) {
    if (transpiled[PREPARED]) return transpiled;

    // Add an inline sourcemap if possible.
    let code = transpiled.code;
    const map = transpiled.map && Object.assign({}, transpiled.map);
    if (map && map.version === 3) {
      // Patch sourcemap for insertions by Function constructor.
      // We only need to prepend a semicolon to `mappings` for each line
      // of code added at the start.
      // https://docs.google.com/document/d/1U1RGAehQwRypUTovF1KRlpiOFze0b-_2gc6fAH0KY0k/edit
      map.mappings = new Array(SOURCEMAP_OFFSET).fill(';').join('') + map.mappings;

      // Add the sourcemap inline to the code.
      const json = JSON.stringify(map);
      const url = `data:application/json;charset=utf-8;base64,${btoa(json)}`;
      if (url.length < 2 ** 23) {
        code += `\n//# sourceMappingURL=${url}`;
      } else {
        console.warn(`proxy-script sourcemap omitted due to size (${url.length} bytes)`);
      }
    }
    return { code, map, [PREPARED]: true };
  }

  /**
   * @param {{code: string, map?: object}} transpiled 
   * @param {object?} [thisArg]
   * @param {object} [args] 
   */
  async runPrepared(transpiled, thisArg, args = {}) {
    console.assert(transpiled[PREPARED], 'running unprepared code');
    this.whitelist.add = () => {
      throw new Error('whitelist modification after run');
    };
    this.blacklist.add(Function);
    this.blacklist.add(AsyncFunction);
    this.blacklist.add(eval);

    args = Object.assign({}, args, {
      '_wrap':       this.maybeWrap.bind(this),
      '_call':       this.call.bind(this)
    });
    const [keys, values] = Object.entries(args)
      .reduce((result, pair) => [[...result[0], pair[0]], [...result[1], pair[1]]], [[], []]);
    const f = new Function(...keys, transpiled.code);
    return await f.call(thisArg, ...values);
  }

  /**
   * @param {{code: string, map?: object}} transpiled 
   * @param {object?} thisArg
   * @param {object} args 
   * @returns {Promise}
   */
  run(transpiled, thisArg, args) {
    if (!transpiled[PREPARED]) {
      transpiled = this.prepare(transpiled);
    }
    return this.runPrepared(transpiled, thisArg, args);
  }
}
Runtime.Error = class extends Error {
  constructor(message, { line, column }) {
    super(`${message} (${line}:${column})`);
    this.line = line;
    this.column = column;
  }
};

/**
 * Update collection of global objects in case of additions to the
 * global scope after module load.
 */
Runtime.updateGlobals = () => {
  getGlobals(globalThis);
};

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

export { Runtime, Transpiler };
//# sourceMappingURL=proxy-script.js.map