# proxy-script
This module allows running untrusted JavaScript within a regular
JavaScript context. It has two goals:

* Prevent changes to objects in the global scope.
* Prevent calls to non-whitelisted external functions.

Limiting resource usage, e.g. memory or CPU cycles, is *not* an
explicit goal, though some limits can be achieved with this framework.

[Try it](https://rhashimoto.github.io/proxy-script/)!

## Getting started
TBD

## How it works (and how to attack it)
TBD

## Acknowledgments
proxy-script depends on the [Babel](https://babeljs.io/) transpiler.
