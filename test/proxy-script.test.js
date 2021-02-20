// Copyright 2021 Roy T. Hashimoto. All rights reserved.

import * as Babel from '@babel/standalone';
import { Transpiler, Runtime } from '../src/index';

globalThis.Babel = Babel;
Transpiler.register(Babel);

describe('proxy-test', () => {
  test('transpiler works with no options', () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile('1 + 1');
    expect(transpiled.code).toBeDefined();
  });

  test('transpiler uses fixed wrapper alias', () => {
    const transpiler = new Transpiler({
      bindings: {
        wrap: 'myWrap',
        call: 'myCall',
        func: 'myFunc',
        klass: 'myKlass',
        external: 'myExternal'
      }
    });
    const transpiled = transpiler.transpile('({}).foo');
    expect(transpiled.code).toMatch(/myWrap/);
    expect(transpiled.code).toMatch(/myCall/);
    expect(transpiled.code).toMatch(/myFunc/);
    expect(transpiled.code).toMatch(/myKlass/);
    expect(transpiled.code).toMatch(/myExternal/);
    expect(transpiled.code).toMatchSnapshot();
  });

  test('runtime returns value', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile('return 42;');

    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toBe(42);
  });

  test('runtime passes arguments', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile('return a + b;');

    const runtime = new Runtime();
    const result = runtime.run(transpiled, undefined, { a: 1, b: 2 });
    await expect(result).resolves.toBe(3);
  });

  test('runtime passes target (thisArg)', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile('return this.foo;');

    const runtime = new Runtime();
    const result = runtime.run(transpiled, { foo: 42 });
    await expect(result).resolves.toBe(42);
  });

  test('runtime allows whitelisted free function call', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile('return isFinite(3.14);');

    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toBe(true);
  });

  test('runtime rejects non-whitelisted free function call', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile('return isFinite(3.14);');

    const runtime = new Runtime();
    runtime.whitelist.delete(isFinite);
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('runtime allows whitelisted static object call', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile('return Math.pow(2, 8);');

    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toBe(256);
  });

  test('runtime rejects non-whitelisted static object call', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile('return Math.pow(2, 8);');

    const runtime = new Runtime();
    runtime.whitelist.delete(Math.pow);
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('runtime allows whitelisted construction', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile('return new Array();');

    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toBeDefined();
  });

  test('runtime rejects non-whitelisted construction', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile('return new Array();');

    const runtime = new Runtime();
    runtime.whitelist.delete(Array);
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('runtime allows whitelisted methods', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      const m = new Map();
      m.set('foo', 'bar');
      return m.get('foo');
    `);

    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toBe('bar');
  });

  test('runtime rejects non-whitelisted methods', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      const m = new Map();
      m.set('foo', 'bar');
      return m.get('foo');
    `);

    const runtime = new Runtime();
    runtime.whitelist.delete(Map.prototype.set);
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
});

  test('runtime rejects global object mutation', async () => {
    {
      // Assigning to an existing property.
      const transpiler = new Transpiler();
      const transpiled = transpiler.transpile('Object.assign = null;');
      const runtime = new Runtime();
      const result = runtime.run(transpiled);
      await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
    }  
    {
      // Assigning to a new property.
      const transpiler = new Transpiler();
      const transpiled = transpiler.transpile('Object.brandNewProperty = null;');
      const runtime = new Runtime();
      const result = runtime.run(transpiled);
      await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
    }  
  });

  test('runtime allows whitelisted indirect call', async () => {
    // Attempt to access the Object constructor via a literal.
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile('return ({}).constructor()');

    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toEqual({});
  });

  test('runtime rejects non-whitelisted indirect call', async () => {
    // Attempt to access the Object constructor via a literal.
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile('return ({}).constructor()');

    const runtime = new Runtime();
    runtime.whitelist.delete(Object); // remove Object from whitelist
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('runtime rejects Object.assign() to global', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`Object.assign(Object, { foo: 0 })`);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('runtime rejects calling eval', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      eval('globalThis');
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('runtime rejects Function constructor', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      new Function('globalThis');
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('runtime rejects indirect Function construction', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      new (() => {}).constructor('globalThis')
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('runtime rejects indirect AsyncFunction construction', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      new (async () => {}).constructor('globalThis')
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('shadowing wrapper function fails', async () => {
    // The transpiler adds a wrapper function around every expression
    // that could be a global object. If we can redefine the wrapper
    // function then the Proxy guards are bypassed.
    //
    // This doesn't work because the wrapper function has a randomly
    // generated name every time code is transpiled.
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      (function () {
        // Attempt to shadow the wrapper function with a no-op.
        const _wrapWithProxy = x => x;
        Object.foo = 'foo';
      })();
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('function arguments are access checked', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      function foo(a) {
        return a(2, 4);
      }
      return foo(Math.pow);
    `);
    const runtime = new Runtime();
    runtime.whitelist.delete(Math.pow);
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('code inside functions is access checked', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      function foo() {
        return Math.pow(2, 4);
      }
      return foo();
    `);
    const runtime = new Runtime();
    runtime.whitelist.delete(Math.pow);
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('Promise inside function works', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      async function foo() {
        return await Promise.resolve(42);
      }
      return foo();
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toBe(42);
  });

  test('Function.prototype.call method works for whitelisted function', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      return Array.prototype.map.call('abc', x => x);
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toEqual(['a', 'b', 'c']);
  });

  test('Function.prototype.apply method works for whitelisted function', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      return Array.prototype.map.apply('abc', [x => x]);
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toEqual(['a', 'b', 'c']);
  });

  test('Function.prototype.call method rejects for non-whitelisted function', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      return Array.prototype.map.call('abc', x => x);
    `);
    const runtime = new Runtime();
    runtime.whitelist.delete(Array.prototype.map);
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('Function.prototype.apply method rejects for non-whitelisted function', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      return Array.prototype.map.apply('abc', [x => x]);
    `);
    const runtime = new Runtime();
    runtime.whitelist.delete(Array.prototype.map);
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('runtime allows nested Promise.resolve() inside function', async () => {
    // The issue here is that V8 (at least) can be temperamental about
    // accepting a Proxy of a Promise as a Promise.
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      function foo() {
        return Promise.resolve(Promise.resolve(42));
      }
      return foo();
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toBe(42);
  });

  test('runtime rejects Function subclass', async () => {
    // If we can manage to create a function from a string then that
    // provides unrestricted access to the global scope. A direct call
    // to `new Function(...)` isn't allowed, but how about subclassing?
    //
    // This is prevented because here we actually subclass a Proxy, so
    // the call via `super()` is intercepted.
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      class Foo extends Function {
        constructor(source) {
          super(source);
        }
      };

      const foo = new Foo('return 42;');
      return foo();
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('prefix/postfix update (++ and --)', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      let i = 0;
      let j = ++i;
      let k = j--;
      return [i, j, k];
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toEqual([1, 0, 1]);
  });

  test('using with to shadow wrapper fails', async () => {
    // The idea here is to extract the random wrapper alias by examining
    // the code's own source, then setting up a `with` block that shadows
    // the wrapper.
    //
    // This fails for several reasons. Both the transpiler and runtime
    // use strict mode, so `arguments.callee` and `with` are not allowed.
    // Also, the default whitelist and settings don't include
    // `Function.prototype.toString`.
    const transpiler = new Transpiler({ bindings: { wrap: '$$' } });
    transpiler.babelOptions.parserOpts.strictMode = false;
    const transpiled = transpiler.transpile(`
      const text = arguments.callee.toString();
      const m = text.match(/(\w+) = _wrapWithProxy/);
      const wrapperName = m[1];
      with ({ [wrapperName]: x => x }) {
        // evil code goes here
      }
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).rejects.toThrowErrorMatchingSnapshot();
  });

  test('literal member expression', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      return 'abc'.repeat(3);
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toBe('abcabcabc');
  });

  test('Object.defineProperty() works on user object', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      class MyMap extends Map {
        constructor() { super(); }
      }
      Object.defineProperty(MyMap.prototype, 'foo', {
        value: 42
      });

      const obj = new MyMap();
      return obj.foo;
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toBe(42);
  });

  test('Object.defineProperty() rejects on global object', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      const MyMap = Map;
      Object.defineProperty(MyMap.prototype, 'foo', {
        value: 42
      });

      const obj = new MyMap();
      return obj.foo;
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('Object.deleteProperty() works on user object', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      class MyMap {
        has() { return true; }
      }

      const obj = new MyMap();
      delete MyMap.prototype.has;

      return 'has' in obj;
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toBe(false);
  });

  test('Object.deleteProperty() rejects on global object', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      const MyMap = Map;

      const obj = new MyMap();
      delete MyMap.prototype.has;

      return 'has' in obj;
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('map succeeds with whitelisted functions', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      return [42, '42', Math.sqrt(-1)].map(isNaN);
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toEqual([false, false, true]);
  });

  test('map rejects with non-whitelisted functions', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      return [42, '42', Math.sqrt(-1)].map(isNaN);
    `);
    const runtime = new Runtime();
    runtime.whitelist.delete(isNaN);
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('bind succeeds with whitelisted functions', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      const f = Array.prototype.reverse.bind([1, 2, 3]);
      return f();
    `);
    const runtime = new Runtime();
    const result = runtime.run(transpiled);
    await expect(result).resolves.toEqual([3, 2, 1]);
  });

  test('bind rejects with non-whitelisted functions', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      const f = Array.prototype.reverse.bind([1, 2, 3]);
      return f();
    `);
    const runtime = new Runtime();
    runtime.whitelist.delete(Array.prototype.reverse);
    const result = runtime.run(transpiled);
    await expect(result.catch(e => e)).resolves.toBeInstanceOf(Runtime.Error);
  });

  test('Error locations are translated with source map', async () => {
    const transpiler = new Transpiler();
    const transpiled = transpiler.transpile(`
      // This comment is line 2.
      throw new Error('this is line 3');
    `);

    const runtime = new Runtime();
    const result = await runtime.run(transpiled).catch(e => e);
    expect(result.stack).toMatch(/<proxy-script>:3/);
  });
});
