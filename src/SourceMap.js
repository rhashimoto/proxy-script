export class SourceMap {
  groups = [];

  constructor(map) {
    // https://docs.google.com/document/d/1U1RGAehQwRypUTovF1KRlpiOFze0b-_2gc6fAH0KY0k/edit
    /** @type {number?} */ let sourcesIndex = null;
    /** @type {number?} */ let sourceLine = null;
    /** @type {number?} */ let sourceColumn = null;
    /** @type {number?} */ let namesIndex = null;
    map.mappings.split(';').forEach(group => {
      /** @type {number?} */ let startColumn = null;
      this.groups.push(group.split(',').map(segment => {
        const fields = parseSegment(segment);
        switch (fields.length) {
          case 5:
            namesIndex += fields[4];
          case 4:
            sourceColumn += fields[3];
          case 3:
            sourceLine += fields[2];
          case 2:
            sourcesIndex += fields[1];
          case 1:
            startColumn += fields[0];
          case 0:
            break;
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
      this.groups.forEach(group => group.sort((a, b) => {
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
    const group = this.groups[line] || [];
    return group.find(segment => segment.startColumn <= column);
  }

  patchStackTrace(trace) {
    return trace.split('\n')
      // TODO: Add processing for Firefox. Edge is Chromium/V8 based so
      // should already work (but should be checked). Safari doesn't have
      // useful stack traces for `new Function()`.
      .map(frame => this.patchV8(frame))
      .join('\n');
  }

  patchV8(frame) {
    const m = frame.match(/^(.*at )eval .*<anonymous>:(\d+):(\d+)/);
    if (m) {
      const line = parseInt(m[2]) - 1;
      const column = parseInt(m[3]);
      const location = this.locate(line, column);
      if (location) {
        return `${m[1]}${location.source}:${location.sourceLine + 1}:${location.sourceColumn}`;
      }
    }
    return frame;
  }
}

/**
 * @param {string} trace stack trace from Error.stack
 * @param {object} map source map
 * @returns {string} patched stack strace
 */
SourceMap.patchStackTrace = (trace, map) => {
  const sourceMap = new SourceMap(map);
  return sourceMap.patchStackTrace(trace);
};

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
export function parseSegment(segment) {
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