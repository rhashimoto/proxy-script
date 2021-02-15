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

export class Transpiler {
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
    const pluginOptions = Object.assign({}, options);
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
};

Transpiler.register = function(babel) {
  babel.registerPlugin('proxy-script', plugin);
}

function createRandomString() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
}