// Copyright 2021 Roy T. Hashimoto. All rights reserved.
import {
  DEFAULT_GLOBAL_CLASSES,
  DEFAULT_GLOBAL_FUNCTIONS,
  DEFAULT_GLOBAL_OBJECTS
} from './constants.js';

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

  globals = new Set(DEFAULT_GLOBALS);
  externals = new Set();

  /**
   * @param {{ bindings?: object }} [options] 
   */
  constructor(options = {}) {
    options = Object.assign({
      globals: this.globals,
      externals: this.externals
    }, options)
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
};

Transpiler.register = function(babel) {
  Babel = babel;
  babel.registerPlugin('proxy-script', plugin);
}

function createRandomString() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
}
