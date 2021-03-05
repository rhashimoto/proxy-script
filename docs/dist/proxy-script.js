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
];

const DEFAULT_GLOBAL_FUNCTIONS = [
  'atob', 'btoa', 'isFinite', 'isNaN', 'parseFloat', 'parseInt'
].filter(name => globalThis.hasOwnProperty(name));

// Copyright 2021 Roy T. Hashimoto. All rights reserved.

const DEFAULT_GLOBALS = [
  DEFAULT_GLOBAL_CLASSES,
  DEFAULT_GLOBAL_FUNCTIONS,
  DEFAULT_GLOBAL_OBJECTS
].flat();

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

let Babel;

function plugin({ types, template }, options) {
  // Support functions are given a random alias to prevent shadowing.
  const bindings = Object.assign({
    wrap: '_w' + createRandomString(),
    call: '_c' + createRandomString(),
    func: '_f' + createRandomString(),
    klass: '_k' + createRandomString()
  }, options.bindings);
 
  // All global objects are wrapped by a Proxy to prevent mutation.
  const wrap = template.expression(`${bindings.wrap}(NODE)`, {
    placeholderPattern: /^NODE$/
  });

  // Use a helper function for method calls for proper binding.
  const call = template.expression(`${bindings.call}(OBJECT, PROPERTY, ARGS)`, {
    placeholderPattern: /^(OBJECT|PROPERTY|ARGS)$/
  });

  // All transiled function definitions are converted to lambdas (if not
  // already a lambda) and registered using a wrapper.
  const lambda = template.expression(`${bindings.func}(LAMBDA)`, {
    placeholderPattern: /^(LAMBDA)$/
  });

  const convertToLambda = (id, node) => lambda({
    LAMBDA: types.FunctionExpression(
      id,
      node.params,
      node.body,
      node.generator,
      node.async)
  });

  const declaration = template.statement(`let ID = LAMBDA;`, {
    placeholderPattern: /^(ID|LAMBDA)$/
  });

  // Register class methods.
  const classDecl = template.statement(`let NAME = ${bindings.klass}(CLASS)`, {
    placeholderPattern: /^(NAME|CLASS)$/
  });
  const classExpr = template.expression(`${bindings.klass}(CLASS)`, {
    placeholderPattern: /^(CLASS)$/
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
    placeholderPattern: /^(BODY)$/
  });

  const checkedForWrap = Symbol('checkedForWrap');
  return {
    visitor: {
      Program(path) {
        path.node.body = iife({
          BODY: path.node.body
        });
      },

      // Check anything that could evaluate to an object or function.
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

        // Use helper function for method calls.
        if (path.isCallExpression()) {
          const callee = path.get('callee');
          if (callee.isMemberExpression()) {
            // Private method calls are not transformed.
            const property = callee.get('property');
            if (!property.isPrivateName()) {
              path.replaceWith(call({
                OBJECT: callee.node.object,
                PROPERTY: callee.node.computed ? property.node : `'${property.node.name}'`,
                ARGS: path.node.arguments
              }));
            }
          }
        }

        // Don't bother wrapping an expression whose value is discarded.
        if (path.parentPath.isExpressionStatement({ expression: path.node })) return;

        // Register lambdas. They don't need to be wrapped further because
        // they can't be an external object.
        if (path.isFunctionExpression() || path.isArrowFunctionExpression()) {
          path.replaceWith(lambda({ LAMBDA: path.node }));
          return;
        }
        
        // Handle external references. Any externals that are not whitelisted
        // globals must be supplied at runtime.
        if (path.isIdentifier() &&
            !path.scope.hasBinding(path.node.name, true) &&
            !options.globals.has(path.node.name)) {
          options.externals.add(path.node.name);
        }

        path.replaceWith(wrap({ NODE: path.node }));
      },

      // Register user functions.
      FunctionDeclaration(path) {
        if (!path.node.loc) return;

        path.replaceWith(declaration({
          ID: path.node.id,
          LAMBDA: convertToLambda(path.node.id, path.node)
        }));
      },
      
      // Register user functions.
      ObjectMethod(path) {
        if (!path.node.loc) return;

        path.replaceWith(types.ObjectProperty(
          path.node.key,
          lambda({
            LAMBDA: convertToLambda(null, path.node)
          }),
          path.node.computed
        ));
      },

      // Register user functions.
      ClassDeclaration(path) {
        if (!path.node.loc) return;

        path.replaceWith(classDecl({
          NAME: types.Identifier(path.node.id.name),
          CLASS: types.classExpression(
            path.node.id,
            path.node.superClass,
            path.node.body)
        }));
      },

      ClassExpression(path) {
        if (!path.node.loc) return;

        path.replaceWith(classExpr({
          CLASS: types.classExpression(
            path.node.id,
            path.node.superClass,
            path.node.body)
        }));

      }
    }
  }
}

class Transpiler {
  babel = Babel;
  babelOptions = {
    parserOpts: {
      strictMode: true,
      allowReturnOutsideFunction: true
    },
    plugins: ['syntax-top-level-await'],
    sourceMaps: true
  };

  globals = new Set(DEFAULT_GLOBALS);
  externals = new Set();

  /**
   * @param {{ bindings?: object }} [options] 
   */
  constructor(options = {}) {
    options = Object.assign({
      globals: this.globals,
      externals: this.externals
    }, options);
    // @ts-ignore
    this.babelOptions.plugins.push(['proxy-script', options]);
  }

  /**
   * @param {string} source 
   * @returns {object}
   */
  transpile(source) {
    const result = this.babel.transform(source, this.babelOptions);
    result.externals = new Set(this.externals.keys());
    return result;
  }
}
Transpiler.register = function(babel) {
  Babel = babel;
  babel.registerPlugin('proxy-script', plugin);
};

function createRandomString() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
}

// Determine number of lines inserted by Function constructor. We need
// this information to patch the sourcemap for browser Dev Tools, and
// it varies with the Javascript implementation.
const SOURCEMAP_OFFSET = (function() {
  const lines = new Function('debugger').toString().split('\n');
  return lines.findIndex(line => line.includes('debugger'));
})();

class SourceMap {
  _groups = [];

  constructor(map) {
    // https://docs.google.com/document/d/1U1RGAehQwRypUTovF1KRlpiOFze0b-_2gc6fAH0KY0k/edit
    /** @type {number?} */ let sourcesIndex = null;
    /** @type {number?} */ let sourceLine = null;
    /** @type {number?} */ let sourceColumn = null;
    /** @type {number?} */ let namesIndex = null;
    map.mappings.split(';').forEach(group => {
      /** @type {number?} */ let startColumn = null;
      this._groups.push(group.split(',').map(segment => {
        const fields = parseSegment(segment);
        switch (fields.length) {
          case 5: namesIndex   += fields[4];
          case 4: sourceColumn += fields[3];
          case 3: sourceLine   += fields[2];
          case 2: sourcesIndex += fields[1];
          case 1: startColumn  += fields[0];
        }
        return {
          startColumn,
          source: map.sources[sourcesIndex],
          sourceLine,
          sourceColumn,
          name: map.names[namesIndex]
        };
      }));

      // Sort segments in a group by decreasing startColumn for easier lookup.
      this._groups.forEach(group => group.sort((a, b) => {
        return a.startColumn >= b.startColumn ? -1 : 1;
      }));
    });
  }

  /**
   * Returns original source zero-based location.
   * @param {number} line zero-based line in generated code
   * @param {number} column zero-based column in generated code
   */
  locate(line, column) {
    const group = this._groups[line] || [];
    return group.find(segment => segment.startColumn <= column);
  }

  patchStackTrace(trace) {
    return trace.split('\n')
      // Apply Javascript implementation-specific patches.
      // Safari doesn't have useful stack traces for `new Function()`.
      .map(frame => this.patchV8(frame))
      .map(frame => this.patchFirefox(frame))
      .join('\n');
  }

  patchV8(frame) {
    const m = frame.match(/^(.*eval at run .*)<anonymous>:(\d+):(\d+)/);
    if (m) {
      // Note adjustments for 1-based line numbers.
      const line = parseInt(m[2]) - 1;
      const column = parseInt(m[3]);
      const location = this.locate(line, column);
      if (location) {
        return `${m[1]}<${location.source}>:${location.sourceLine + 1}:${location.sourceColumn})`;
      }
    }
    return frame;
  }

  patchFirefox(frame) {
    const m = frame.match(/^(.* )Function:(\d+):(\d+)$/);
    if (m) {
      // Note adjustments for 1-based line numbers.
      const line = parseInt(m[2]) - 1;
      const column = parseInt(m[3]);
      const location = this.locate(line, column);
      if (location) {
        return `${m[1]}<${location.source}>:${location.sourceLine + 1}:${location.sourceColumn}`;
      }
    }
    return frame;
  }
}

/**
 * Patch sourcemap for insertions by Function constructor.
 * @param {object} map source map
 */
SourceMap.patchMapForFunctionWrapper = function(map) {
  // Prepend a semicolon to `mappings` for each line of code added at
  // the start.
  map.mappings = new Array(SOURCEMAP_OFFSET).fill(';').join('') + map.mappings;
};

/**
 * Build an inline map with a data URL.
 * @param {*} map source map
 */
SourceMap.createInline = function(map) {
  // @ts-ignore
  const btoa = globalThis.btoa ?? (s => Buffer.from(s).toString('base64'));
  const json = JSON.stringify(map);
  const url = `data:application/json;charset=utf-8;base64,${btoa(json)}`;
  return `//# sourceMappingURL=${url}`;
};

/**
 * Translate stack trace locations through a source map.
 * @param {string} trace stack trace from Error.stack
 * @param {object} map source map
 * @returns {string} patched stack strace
 */
SourceMap.patchStackTrace = (trace, map) => {
  const sourceMap = new SourceMap(map);
  return sourceMap.patchStackTrace(trace);
};

/**
 * Map a base64 digit to its numeric value.
 * @type {Map<string, number>}
 */
const BASE_64 = new Map([
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '/'
].map((c, i) => [c, i]));

/**
 * @param {string} segment 
 * @returns {Array<number>} segment numeric fields
 */
function parseSegment(segment) {
  const fields = [];

  // Parse VLQs (top bit of digit is continuation bit, LSB of first
  // digit is sign bit). This code only works to 31-bit values instead
  // of the specified 32-bits, which is not expected to be a problem.
  let nBits = 0;
  let value = 0;
  for (const c of segment) {
    const data = BASE_64.get(c);
    if (data === undefined) throw new Error('invalid base64');

    value += (data & 0x1f) << nBits;
    nBits += 5;
    if ((data & 0x20) === 0) {
      const sign = (value & 0x1) ? -1 : 1;
      fields.push(sign * (value >>> 1));
      nBits = value = 0;
    }
  }

  return fields;
}

// Copyright 2021 Roy T. Hashimoto. All rights reserved.

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
  eval
]);

class Runtime {
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
}
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
};

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
};

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

export { Runtime, Transpiler };
//# sourceMappingURL=proxy-script.js.map
