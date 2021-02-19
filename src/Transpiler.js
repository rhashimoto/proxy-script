// Copyright 2021 Roy T. Hashimoto. All rights reserved.

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
  const bindings = Object.assign({
    wrap: '_w' + createRandomString(),
    call: '_c' + createRandomString(),
    func: '_f' + createRandomString(),
    klass: '_k' + createRandomString(),
    external: '_e' + createRandomString()
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

  // All function definitions are converted to lambdas (if not already a
  // lambda) and registered using a wrapper.
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

  const klass = template.statement(`${bindings.klass}(CLASS)`, {
    placeholderPattern: /^(CLASS)$/
  });

  const external = template.expression(`${bindings.external}('NAME')`, {
    placeholderPattern: /^(NAME)$/
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

        // Use helper function for calls.
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
          // } else if (!callee.isSuper()) {
          //   // Not a method call, i.e. not bound to an object.
          //   path.replaceWith(call({
          //     OBJECT: callee.node,
          //     PROPERTY: types.NullLiteral(),
          //     ARGS: path.node.arguments
          //   }));
          }
        }

        // Don't bother wrapping an expression whose value is discarded.
        if (path.parentPath.isExpressionStatement({ expression: path.node })) return;

        // Use a different wrapper for lambdas.
        if (path.isFunctionExpression() || path.isArrowFunctionExpression()) {
          path.replaceWith(lambda({ LAMBDA: path.node }));
          return;
        }
        
        // Fetch external references.
        if (path.isIdentifier() && !path.scope.hasBinding(path.node.name, true)) {
          path.replaceWith(external({ NAME: path.node.name }))
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

        path.insertAfter(klass({ CLASS: types.Identifier(path.node.id.name) }));
      }
    }
  }
}

export class Transpiler {
  babel = Babel;
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
  Babel = babel;
  babel.registerPlugin('proxy-script', plugin);
}

function createRandomString() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
}