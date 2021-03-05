# proxy-script
[![Node.js CI](https://github.com/rhashimoto/proxy-script/actions/workflows/node.js.yml/badge.svg)](https://github.com/rhashimoto/proxy-script/actions/workflows/node.js.yml)

This module allows running untrusted JavaScript within a regular
JavaScript context. It has two goals:

* Prevent changes to objects in the global scope.
* Prevent calls to non-whitelisted external functions.

Limiting resource usage, e.g. memory or CPU cycles, is not an
explicit goal, though some limits are possible with this framework.

[Try it](https://rhashimoto.github.io/proxy-script/)!

## Features
* Minimal API.
* Extensible (examples TBD).
* Debuggable with browser Developer Tools.
* Transpiler and Runtime can be in separate JavaScript contexts.
* Alternative licensing negotiable.

## Getting started
Install from GitHub with `yarn add proxy-script@rhashimoto/proxy-script`.

```javascript
import { Transpiler, Runtime } from 'proxy-script';

Transpiler.register(Babel); // 1

const transpiler = new Transpiler(); // 2
const transpiled = transpiler.transpile(scriptString); // 3

const runtime = new Runtime(); // 4
const result = await runtime.run(transpiled); // 5
```

1. `Transpiler.register()` must be called with the Babel instance
before using the transpiler.
2. The constructor takes an optional options argument, which is
mainly useful for adding custom plugin features (and testing). The
`globals` property (of type `Set`) can be used configuring access
to names in the global scope.
3. `transpile()` returns the result of
[`Babel.transform()`](https://babeljs.io/docs/en/babel-core#transform).
4. The constructor takes no arguments. The `whitelist` property
(of type `Set`) can be used for configuring permitted functions.
Note that the runtime can be used in a separate JavaScript context
from the transpiler.
5. `run()` takes an optional argument for binding external references
that are not in the global scope.

See the
[examples](https://github.com/rhashimoto/proxy-script/tree/master/docs)
and
[tests](https://github.com/rhashimoto/proxy-script/tree/master/test)
for usage samples.

## How it works (and how to attack it)
proxy-script uses two components - a transpiler that injects
wrappers into untrusted code, and a runtime that implements the
wrapper functions.

### Transpiler
The transpiler is implemented as a Babel plug-in. It encapsulates
the supplied code in an async
[IIFE](https://developer.mozilla.org/en-US/docs/Glossary/IIFE)
and wraps any expression that *might* be a global object in a
function call. The wrapper functions are called via random aliases
so the untrusted code can't shadow them.

For example, the transpiler converts this...

```javascript
console.log('Hello, world!');
```

...to this:

```javascript
"use strict";

const _w2b13ks5rnph = _wrap;
const _c185u9d2xcwf = _call;
const _f1pxgpwqrlyd = _func;
const _k2981j4akxuf = _klass;
return (async () => {
  _c185u9d2xcwf(_w2b13ks5rnph(console), 'log', 'Hello, world!');
})();
```

### Runtime
The runtime implements the wrapper functions referenced in the
transpiled code. Basically, the wrappers do this:

* If the wrapped expression is a "global object" (see below),
it is wrapped in a
[Proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy).

* If a proxied object is mutated (e.g. setting properties),
an exception is thrown.

* If an object used as a constructor or function is not found on
the whitelist, an exception is thrown.

In the above example, `console` is checked whether it is a global
object (yes) and wrapped in a Proxy. The method call is implemented
by a support function that checks whether the member `log` is in
the whitelist (yes by default) and makes the call.

### What is a "global object"?
When the Runtime class is loaded it recursively traverses the
object tree rooted at `globalThis` and adds everything it finds
to its set of global objects. Anything found in the traversal
cannot be mutated by the transpiled code.

Only global objects that are explicitly specified can be accessed by
name in transpiled code. By default, only objects in the Javascript
language definition are provided.

### Attacker suggestions
* Look for an indirect way to invoke the Function or AsyncFunction
constructor. This is the most direct way to escape the sandbox.

* Look for a bug in the Transpiler plugin (or Babel itself)
that causes some expression that should be wrapped not to
be wrapped.

## Recommendations
Defense in depth:
* If possible, put the Runtime in its own JavaScript context,
e.g. an iframe (ideally
[sandboxed](https://www.html5rocks.com/en/tutorials/security/sandboxed-iframes/),
and with a separate origin)
or a
[Worker](https://developer.mozilla.org/en-US/docs/Web/API/Worker)
(or both!).

* Use a [Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
or a [Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
(or both!) to prevent untrusted code from arbitrary network access.
If using a CSP, Runtime needs `script-src 'unsafe-eval'`.

* Use [`Object.freeze()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/freeze)
to protect objects, including those in the global scope and those
passed as arguments.

## Acknowledgments
proxy-script depends on the [Babel](https://babeljs.io/) transpiler.
