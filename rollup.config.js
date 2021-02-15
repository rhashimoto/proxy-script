import commonjs from "@rollup/plugin-commonjs";

const OUT_DIR = 'docs/dist';

export default {
  input: "src/index.js",

  output: {
    file: 'docs/dist/proxy-script.js',
    sourcemap: true,
    format: 'esm',
    exports: "named",
  },
  plugins: [
    commonjs()
  ],
};
