/** Test-only literal inventory, not a CSS validator or contrast measurement. */
const named = new Set(
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(
    ' ',
  ),
);
const functions = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'device-cmyk']);

function stringEnd(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === quote) return index + 1;
  }
  throw new Error('Unterminated CSS string in color inventory.');
}

function uncomment(text: string): string {
  let output = '';
  for (let index = 0; index < text.length;) {
    if (text[index] === '"' || text[index] === "'") {
      const end = stringEnd(text, index);
      output += text.slice(index, end);
      index = end;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw new Error('Unterminated CSS comment in color inventory.');
      output += ' ';
      index = end + 2;
    } else output += text[index++];
  }
  return output;
}

function hasLiteral(value: string): boolean {
  for (let index = 0; index < value.length;) {
    if (value[index] === '"' || value[index] === "'") {
      index = stringEnd(value, index);
      continue;
    }
    if (value[index] === '\\') throw new Error('Escaped CSS value requires explicit color-inventory review.');
    if (value[index] === '#' && /^#[0-9a-f]{3,8}(?![a-z0-9_-])/i.test(value.slice(index))) return true;
    const word = /^[-_a-z][-_a-z0-9]*/i.exec(value.slice(index))?.[0];
    if (!word) {
      index++;
      continue;
    }
    const lower = word.toLowerCase();
    index += word.length;
    if (lower === 'url' && value[index] === '(') {
      let depth = 1;
      index++;
      for (; index < value.length && depth; index++) {
        if (value[index] === '"' || value[index] === "'") {
          index = stringEnd(value, index) - 1;
          continue;
        }
        if (value[index] === '\\') {
          index++;
          continue;
        }
        if (value[index] === '(') depth++;
        if (value[index] === ')') depth--;
      }
      if (depth) throw new Error('Unterminated CSS URL in color inventory.');
    } else if (named.has(lower) || (functions.has(lower) && value[index] === '(')) return true;
  }
  return false;
}

/** Records exact declarations rather than allowing every use of a property.
 * Comments and quoted/URL data are not colors. Keywords such as transparent,
 * currentColor and system colors retain browser/theme semantics and are not
 * literal palette values. JS/SVG inline styles are outside this CSS-only gate. */
export interface CssColorDeclaration {
  context: string;
  property: string;
  value: string;
}
export function cssColorInventory(source: string): CssColorDeclaration[] {
  const text = uncomment(source),
    contexts: string[] = [],
    result: CssColorDeclaration[] = [];
  let start = 0,
    parentheses = 0,
    brackets = 0;
  const declaration = (end: number): void => {
    const value = text.slice(start, end).trim();
    if (!value) return;
    const match = /^([a-z_-][a-z0-9_-]*)\s*:([\s\S]*)$/i.exec(value);
    if (!match) {
      if (value.includes('\\')) throw new Error('Escaped CSS declaration requires explicit color-inventory review.');
      return;
    }
    // A stylesheet's `@layer` wraps the whole file (style.css names the order):
    // the reviewed context is the rule's own, wherever its file stands.
    if (hasLiteral(match[2]))
      result.push({ context: contexts.filter((part) => !/^@layer\s/.test(part)).join(' > '), property: match[1], value: match[2].trim() });
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || char === "'") {
      index = stringEnd(text, index) - 1;
      continue;
    }
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '(') parentheses++;
    else if (char === ')') parentheses--;
    else if (char === '[') brackets++;
    else if (char === ']') brackets--;
    else if (!parentheses && !brackets) {
      if (char === '{') {
        contexts.push(text.slice(start, index).trim().replace(/\s+/g, ' '));
        start = index + 1;
      } else if (char === ';') {
        declaration(index);
        start = index + 1;
      } else if (char === '}') {
        declaration(index);
        if (!contexts.length) throw new Error('Unbalanced CSS block.');
        contexts.pop();
        start = index + 1;
      }
    }
    if (parentheses < 0 || brackets < 0) throw new Error('Unbalanced CSS value.');
  }
  if (contexts.length || parentheses || brackets) throw new Error('Unbalanced CSS structure.');
  return result;
}
