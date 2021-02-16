# proxy-script
This module allows running untrusted JavaScript within a regular
JavaScript context. It has two goals:

* Prevent changes to objects in the global scope.
* Prevent calls to non-whitelisted external functions.

Limiting resource usage, e.g. memory or CPU cycles, is *not* an
explicit goal, though some limits can be achieved with this framework.

[Try it](https://rhashimoto.github.io/proxy-script/)!

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
mainly useful for adding custom plugin features (and testing).
3. `transpile()` returns the result of
[`Babel.transform()`](https://babeljs.io/docs/en/babel-core#transform).
4. The constructor takes no arguments. The `whitelist` and
`blacklist` members (of type `Set`) are used for configuration.
Note that the runtime can be used in a separate JavaScript context
from the transpiler.
5. `run()` takes optional arguments for `this` and an object with
argument bindings. Exceptions are thrown for any access violation.

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
and wraps any expression that might be a global object in a
function call. The wrapper functions are called via random aliases
so the untrusted code can't shadow them.

### Runtime
The runtime implements the wrapper functions referenced in the
transpiled code. Basically, the wrappers do this:

* If the wrapped expression is found on the blacklist, an
exception is thrown.
* If the wrapped expression is a "global object" (see below),
it is wrapped in a
[Proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy).
* If a proxied object is mutated (e.g. setting properties),
an exception is thrown.
* If a proxied object is not found on the whitelist and is
called as a constructor or function, an exception is thrown.

### What is a "global object"?
When the Runtime class is loaded it recursively traverses the
object tree rooted at `globalThis` and adds everything it finds
to its set of global objects.

It is possible for there to be external objects provided by
the Javascript platform that are not found by this recursive
search. For example, the async function constructor, though
referred to as
[`AsyncFunction`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncFunction),
is technically not a global object as that name is not defined
in the global scope. Not blocking this constructor would allow
circumventing all the protections, so proxy-script marks it
specifically as a global object and places it on the blacklist.

No other such object is known to be reachable with the
default whitelist and blacklist settings but it is important
to be aware of this possibility, especially if the settings
are changed or if arguments are passed to transpiled code.
For example, the browser `document` object is blacklisted
by default because access to any DOM object opens another
universe of objects and functions, some of which might not
have been reached via the global object traversal.

### Attacker suggestions
* Look for a way to invoke the Function or AsyncFunction
constructor. This is the most direct way to escape the sandbox.
* Look for a way to access a platform object that isn't
marked as a global object. Use of this object will bypass the
whitelist, and data can be stored in it that could persist
across Runtime invocations. Methods can be made inoperable,
though useful hijacking is probably not possible because
few transpiled functions will work outside the runtime.
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
