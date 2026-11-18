export type GoRe2PatternProblem = 'trailing_backslash' | 'unsupported_re2' | 'invalid_syntax';

const POSIX_CLASSES = new Set([
  'alnum', 'alpha', 'ascii', 'blank', 'cntrl', 'digit', 'graph',
  'lower', 'print', 'punct', 'space', 'upper', 'word', 'xdigit',
]);

// Canonicalized keys accepted by Go's regexp/syntax.unicodeTable (Categories, CategoryAliases, Scripts, and special names).
const GO_UNICODE_TABLES = new Set([
  'any', 'ascii', 'assigned',
  'c', 'cc', 'cf', 'cn', 'cntrl', 'co', 'cs', 'other', 'control', 'format', 'unassigned', 'privateuse', 'surrogate',
  'l', 'lc', 'll', 'lm', 'lo', 'lt', 'lu', 'letter', 'casedletter', 'lowercaseletter', 'modifierletter', 'otherletter', 'titlecaseletter', 'uppercaseletter',
  'm', 'mc', 'me', 'mn', 'mark', 'combiningmark', 'spacingmark', 'enclosingmark', 'nonspacingmark',
  'n', 'nd', 'nl', 'no', 'number', 'decimalnumber', 'digit', 'letternumber', 'othernumber',
  'p', 'pc', 'pd', 'pe', 'pf', 'pi', 'po', 'ps', 'punct', 'punctuation', 'connectorpunctuation', 'dashpunctuation', 'closepunctuation', 'finalpunctuation', 'initialpunctuation', 'otherpunctuation', 'openpunctuation',
  's', 'sc', 'sk', 'sm', 'so', 'symbol', 'currencysymbol', 'modifiersymbol', 'mathsymbol', 'othersymbol',
  'z', 'zl', 'zp', 'zs', 'separator', 'lineseparator', 'paragraphseparator', 'spaceseparator',
  'adlam', 'ahom', 'anatolianhieroglyphs', 'arabic', 'armenian', 'avestan', 'balinese', 'bamum', 'bassavah', 'batak',
  'bengali', 'bhaiksuki', 'bopomofo', 'brahmi', 'braille', 'buginese', 'buhid', 'canadianaboriginal',
  'carian', 'caucasianalbanian', 'chakma', 'cham', 'cherokee', 'chorasmian', 'common', 'coptic', 'cuneiform', 'cypriot',
  'cyprominoan', 'cyrillic', 'deseret', 'devanagari', 'divesakuru', 'dogra', 'duployan', 'egyptianhieroglyphs', 'elbasan',
  'elymaic', 'ethiopic', 'georgian', 'glagolitic', 'gothic', 'grantha', 'greek', 'gujarati', 'gunjalagondi',
  'gurmukhi', 'han', 'hangul', 'hanifirohingya', 'hanunoo', 'hatran', 'hebrew', 'hiragana',
  'imperialaramaic', 'inherited', 'inscriptionalpahlavi', 'inscriptionalparthian', 'javanese', 'kaithi', 'kannada',
  'katakana', 'kawi', 'kayahli', 'kharoshthi', 'khitansmallscript', 'khmer', 'khojki', 'khudawadi', 'lao',
  'latin', 'lepcha', 'limbu', 'lineara', 'linearb', 'lisu', 'lycian', 'lydian', 'mahajani', 'makasar', 'malayalam',
  'mandaic', 'manichaean', 'marchen', 'masaramgondi', 'medefaidrin', 'meeteimayek', 'mendekikakui', 'meroiticcursive',
  'meroitichieroglyphs', 'miao', 'modi', 'mongolian', 'mro', 'multani', 'myanmar', 'nabataean', 'nagmundari',
  'nandinagari', 'newa', 'newtailue', 'nko', 'nushu', 'nyiakengpuachuehmong', 'ogham', 'olchiki', 'oldhungarian',
  'olditalic', 'oldnortharabian', 'oldpermic', 'oldpersian', 'oldsogdian', 'oldsoutharabian', 'oldturkic',
  'olduyghur', 'oriya', 'osage', 'osmanya', 'pahawhhmong', 'palmyrene', 'paucinhau', 'phagspa', 'phoenician',
  'psalterpahlavi', 'rejang', 'runic', 'samaritan', 'saurashtra', 'sharada', 'shavian', 'siddham',
  'signwriting', 'sinhala', 'sogdian', 'sorasompeng', 'soyombo', 'sundanese', 'sylotinagri', 'syriac',
  'tagalog', 'tagbanwa', 'taile', 'taitham', 'taiviet', 'takri', 'tamil', 'tangsa', 'tangut', 'telugu',
  'thaana', 'thai', 'tibetan', 'tifinagh', 'tirhuta', 'toto', 'ugaritic',
  'vai', 'vithkuqi', 'wancho', 'warangciti', 'yezidi', 'yi', 'zanabazarsquare',
]);

function isSupportedGoUnicodeTable(name: string): boolean {
  const canonical = name.replace(/[_ -]/g, '').toLowerCase();
  return GO_UNICODE_TABLES.has(canonical);
}

const UNSUPPORTED_ESCAPES = new Set(['k', 'Z', 'K', 'G', 'X', 'C', 'R', 'N', 'u', 'c']);
const ALLOWED_ALPHA_ESCAPES_OUTSIDE = new Set(['A', 'B', 'D', 'S', 'W', 'a', 'b', 'd', 'f', 'n', 'r', 's', 't', 'v', 'w', 'z']);
const ALLOWED_ALPHA_ESCAPES_CLASS = new Set(['D', 'S', 'W', 'a', 'd', 'f', 'n', 'r', 's', 't', 'v', 'w']);
const RE2_FLAGS = new Set(['i', 'm', 's', 'U']);

function isHexDigit(ch: string | undefined): boolean {
  return ch !== undefined && /^[0-9a-fA-F]$/.test(ch);
}

function isOctalDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '7';
}

function scanEscape(
  pattern: string,
  slashIndex: number,
  inCharClass: boolean,
): { nextIndex: number; codePoint?: number; emptyLiteral?: boolean; problem?: GoRe2PatternProblem } {
  if (slashIndex + 1 >= pattern.length) {
    return { nextIndex: slashIndex, problem: 'trailing_backslash' };
  }
  const next = pattern[slashIndex + 1];
  if (!inCharClass && next === 'Q') {
    const closeIdx = pattern.indexOf('\\E', slashIndex + 2);
    const nextIndex = closeIdx === -1 ? pattern.length - 1 : closeIdx + 1;
    const contentLength = closeIdx === -1
      ? pattern.length - (slashIndex + 2)
      : closeIdx - (slashIndex + 2);
    return { nextIndex, emptyLiteral: contentLength === 0 };
  }
  if (next >= '1' && next <= '9') {
    const afterDigit = pattern[slashIndex + 2];
    if (next <= '7' && isOctalDigit(afterDigit)) {
      const third = pattern[slashIndex + 3];
      const consumedDigits = isOctalDigit(third) ? 3 : 2;
      const octalValue = Number.parseInt(pattern.slice(slashIndex + 1, slashIndex + 1 + consumedDigits), 8);
      return { nextIndex: slashIndex + consumedDigits, codePoint: octalValue };
    }
    return { nextIndex: slashIndex + 1, problem: 'unsupported_re2' };
  }
  if (next === '0') {
    let consumed = 1;
    if (isOctalDigit(pattern[slashIndex + 2])) {
      consumed = isOctalDigit(pattern[slashIndex + 3]) ? 3 : 2;
    }
    const octalValue = Number.parseInt(pattern.slice(slashIndex + 1, slashIndex + 1 + consumed), 8);
    return { nextIndex: slashIndex + consumed, codePoint: octalValue };
  }
  if (UNSUPPORTED_ESCAPES.has(next)) {
    return { nextIndex: slashIndex + 1, problem: 'unsupported_re2' };
  }
  if (next === 'x') {
    if (pattern[slashIndex + 2] === '{') {
      const closeBrace = pattern.indexOf('}', slashIndex + 3);
      if (closeBrace === -1) {
        return { nextIndex: slashIndex + 2, problem: 'invalid_syntax' };
      }
      const hex = pattern.slice(slashIndex + 3, closeBrace);
      const cp = Number.parseInt(hex, 16);
      if (!/^[0-9a-fA-F]+$/.test(hex) || cp > 0x10ffff) {
        return { nextIndex: closeBrace, problem: 'invalid_syntax' };
      }
      return { nextIndex: closeBrace, codePoint: cp };
    }
    if (!isHexDigit(pattern[slashIndex + 2]) || !isHexDigit(pattern[slashIndex + 3])) {
      return { nextIndex: slashIndex + 1, problem: 'invalid_syntax' };
    }
    const cp = Number.parseInt(pattern.slice(slashIndex + 2, slashIndex + 4), 16);
    return { nextIndex: slashIndex + 3, codePoint: cp };
  }
  if (next === 'p' || next === 'P') {
    const after = pattern[slashIndex + 2];
    if (after === '{') {
      const closeBrace = pattern.indexOf('}', slashIndex + 3);
      if (closeBrace === -1) {
        return { nextIndex: slashIndex + 2, problem: 'invalid_syntax' };
      }
      const propName = pattern.slice(slashIndex + 3, closeBrace);
      const body = propName.startsWith('^') ? propName.slice(1) : propName;
      if (!isSupportedGoUnicodeTable(body)) {
        return { nextIndex: closeBrace, problem: 'invalid_syntax' };
      }
      return { nextIndex: closeBrace };
    }
    if (after !== undefined && isSupportedGoUnicodeTable(after)) {
      return { nextIndex: slashIndex + 2 };
    }
    return { nextIndex: slashIndex + 1, problem: 'invalid_syntax' };
  }
  const simpleControlEscapes: Record<string, number> = {
    a: 0x07,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
  };
  if (/^[A-Za-z]$/.test(next)) {
    const allowed = inCharClass ? ALLOWED_ALPHA_ESCAPES_CLASS : ALLOWED_ALPHA_ESCAPES_OUTSIDE;
    if (!allowed.has(next)) {
      return { nextIndex: slashIndex + 1, problem: 'invalid_syntax' };
    }
    return { nextIndex: slashIndex + 1, codePoint: simpleControlEscapes[next] };
  }
  const cp = next.codePointAt(0)!;
  if (cp >= 0x80 || /[0-9A-Za-z]/.test(next)) {
    return { nextIndex: slashIndex + 1, problem: 'invalid_syntax' };
  }
  return { nextIndex: slashIndex + 1, codePoint: cp };
}

function readClassAtom(
  pattern: string,
  index: number,
  allowPosix: boolean,
): { nextIndex: number; isSingleChar: boolean; codePoint?: number; problem?: GoRe2PatternProblem } {
  const c = pattern[index];
  if (c === '\\') {
    const escaped = scanEscape(pattern, index, true);
    if (escaped.problem) {
      return { nextIndex: escaped.nextIndex, isSingleChar: false, problem: escaped.problem };
    }
    if (escaped.codePoint !== undefined) {
      return { nextIndex: escaped.nextIndex + 1, isSingleChar: true, codePoint: escaped.codePoint };
    }
    return { nextIndex: escaped.nextIndex + 1, isSingleChar: false };
  }
  if (allowPosix && c === '[' && pattern[index + 1] === ':') {
    const closePosix = pattern.indexOf(':]', index + 2);
    if (closePosix !== -1) {
      const inner = pattern.slice(index + 2, closePosix);
      const name = inner.startsWith('^') ? inner.slice(1) : inner;
      if (!POSIX_CLASSES.has(name)) {
        return { nextIndex: closePosix + 2, isSingleChar: false, problem: 'invalid_syntax' };
      }
      return { nextIndex: closePosix + 2, isSingleChar: false };
    }
  }
  const cp = pattern.codePointAt(index)!;
  const charLen = cp > 0xffff ? 2 : 1;
  return { nextIndex: index + charLen, isSingleChar: true, codePoint: cp };
}

const MAX_RE2_REPEAT = 1000;

interface GroupRepeatFrame {
  parentBranchProduct: number;
  maxRepeatProduct: number;
}

/**
 * Validates a Go RE2 regular expression without false-positively rejecting valid
 * RE2 features (`(?i)`, `(?P<name>...)`, `(?<name>...)`, `\Q...\E`, `[[:alpha:]]`,
 * `[]a]`, `[A-[:]]`, octal `\12`) while catching syntax errors and unsupported Perl/PCRE
 * constructs (lookarounds, backreferences, possessive quantifiers, atomic groups).
 */
export function validateGoRe2Pattern(pattern: string): GoRe2PatternProblem | null {
  const frames: GroupRepeatFrame[] = [{ parentBranchProduct: 1, maxRepeatProduct: 1 }];
  let currentBranchProduct = 1;
  let lastAtomProduct = 1;
  let prevBranchProductBeforeAtom = 1;
  let canRepeat = false;
  let repeatState: 'none' | 'quantifier' | 'lazy' = 'none';

  const commitBranch = () => {
    const top = frames[frames.length - 1];
    if (currentBranchProduct > top.maxRepeatProduct) {
      top.maxRepeatProduct = currentBranchProduct;
    }
    currentBranchProduct = 1;
    lastAtomProduct = 1;
    prevBranchProductBeforeAtom = 1;
  };

  const pushGroupFrame = () => {
    const top = frames[frames.length - 1];
    if (currentBranchProduct > top.maxRepeatProduct) {
      top.maxRepeatProduct = currentBranchProduct;
    }
    frames.push({ parentBranchProduct: currentBranchProduct, maxRepeatProduct: 1 });
    currentBranchProduct = 1;
    lastAtomProduct = 1;
    prevBranchProductBeforeAtom = 1;
  };

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];

    if (ch === '\\') {
      const escaped = scanEscape(pattern, i, false);
      if (escaped.problem) return escaped.problem;
      i = escaped.nextIndex;
      if (escaped.emptyLiteral) {
        repeatState = 'none';
        continue;
      }
      prevBranchProductBeforeAtom = currentBranchProduct;
      lastAtomProduct = 1;
      canRepeat = true;
      repeatState = 'none';
      continue;
    }

    if (ch === '[') {
      let j = i + 1;
      if (pattern[j] === '^') j += 1;
      let first = true;
      let closed = false;
      while (j < pattern.length) {
        if (pattern[j] === ']' && !first) {
          closed = true;
          i = j;
          break;
        }
        first = false;
        const lo = readClassAtom(pattern, j, true);
        if (lo.problem) return lo.problem;
        j = lo.nextIndex;
        if (lo.isSingleChar && pattern[j] === '-' && j + 1 < pattern.length && pattern[j + 1] !== ']') {
          const hi = readClassAtom(pattern, j + 1, false);
          if (hi.problem) return hi.problem;
          if (!hi.isSingleChar || lo.codePoint! > hi.codePoint!) {
            return 'invalid_syntax';
          }
          j = hi.nextIndex;
        }
      }
      if (!closed) {
        return 'invalid_syntax';
      }
      prevBranchProductBeforeAtom = currentBranchProduct;
      lastAtomProduct = 1;
      canRepeat = true;
      repeatState = 'none';
      continue;
    }

    if (ch === '(') {
      if (pattern[i + 1] === '?') {
        if (
          pattern.startsWith('(?=', i)
          || pattern.startsWith('(?!', i)
          || pattern.startsWith('(?<=', i)
          || pattern.startsWith('(?<!', i)
          || pattern.startsWith('(?>', i)
          || pattern.startsWith('(?(', i)
          || pattern.startsWith('(?#', i)
          || pattern.startsWith('(?R', i)
          || pattern.startsWith('(?&', i)
        ) {
          return 'unsupported_re2';
        }
        if (pattern.startsWith('(?P<', i) || pattern.startsWith('(?<', i)) {
          const nameStart = pattern.indexOf('<', i) + 1;
          const nameEnd = pattern.indexOf('>', nameStart);
          if (nameEnd === -1) return 'invalid_syntax';
          const groupName = pattern.slice(nameStart, nameEnd);
          if (!/^[A-Za-z0-9_]+$/.test(groupName)) return 'invalid_syntax';
          pushGroupFrame();
          i = nameEnd;
          canRepeat = false;
          repeatState = 'none';
          continue;
        }
        let j = i + 2;
        let sawMinus = false;
        let flagsAfterMinus = 0;
        let totalFlags = 0;
        let terminatedBy: ':' | ')' | null = null;
        while (j < pattern.length) {
          const fc = pattern[j];
          if (fc === ':' || fc === ')') {
            if (sawMinus && flagsAfterMinus === 0) return 'invalid_syntax';
            if (fc === ':') {
              pushGroupFrame();
            }
            i = j;
            terminatedBy = fc;
            break;
          }
          if (fc === '-') {
            if (sawMinus) return 'invalid_syntax';
            sawMinus = true;
            j += 1;
            continue;
          }
          if (!RE2_FLAGS.has(fc)) {
            return 'unsupported_re2';
          }
          totalFlags += 1;
          if (sawMinus) flagsAfterMinus += 1;
          j += 1;
        }
        if (!terminatedBy || (sawMinus && totalFlags === 0)) {
          return 'invalid_syntax';
        }
        if (terminatedBy === ':') {
          canRepeat = false;
        }
        repeatState = 'none';
        continue;
      }
      pushGroupFrame();
      canRepeat = false;
      repeatState = 'none';
      continue;
    }

    if (ch === ')') {
      if (frames.length <= 1) return 'invalid_syntax';
      commitBranch();
      const finished = frames.pop()!;
      const groupMax = finished.maxRepeatProduct;
      prevBranchProductBeforeAtom = finished.parentBranchProduct;
      lastAtomProduct = groupMax;
      currentBranchProduct = Math.max(finished.parentBranchProduct, groupMax);
      canRepeat = true;
      repeatState = 'none';
      continue;
    }

    if (ch === '|') {
      commitBranch();
      canRepeat = false;
      repeatState = 'none';
      continue;
    }

    if (ch === '*' || ch === '+' || ch === '?') {
      if (ch === '?' && repeatState === 'quantifier') {
        repeatState = 'lazy';
        continue;
      }
      if (repeatState !== 'none' || !canRepeat) {
        return 'invalid_syntax';
      }
      repeatState = 'quantifier';
      canRepeat = true;
      continue;
    }

    if (ch === '{') {
      const repeatMatch = /^\{(0|[1-9]\d*)(?:,(0|[1-9]\d*)?)?\}/.exec(pattern.slice(i));
      if (repeatMatch) {
        if (repeatState !== 'none' || !canRepeat) {
          return 'invalid_syntax';
        }
        const min = Number.parseInt(repeatMatch[1], 10);
        const commaIndex = repeatMatch[0].indexOf(',');
        const hasComma = commaIndex !== -1;
        const maxStr = repeatMatch[2];
        const max = maxStr !== undefined && maxStr !== '' ? Number.parseInt(maxStr, 10) : undefined;
        if (min > MAX_RE2_REPEAT || (max !== undefined && (max > MAX_RE2_REPEAT || max < min))) {
          return 'invalid_syntax';
        }
        const effectiveRepeat = max !== undefined ? max : min;
        if (!hasComma && min === 0 || max === 0) {
          lastAtomProduct = 1;
          currentBranchProduct = prevBranchProductBeforeAtom;
        } else if (effectiveRepeat >= 2) {
          if (lastAtomProduct * effectiveRepeat > MAX_RE2_REPEAT) {
            return 'invalid_syntax';
          }
          lastAtomProduct *= effectiveRepeat;
          if (lastAtomProduct > currentBranchProduct) {
            currentBranchProduct = lastAtomProduct;
          }
        }
        i += repeatMatch[0].length - 1;
        repeatState = 'quantifier';
        canRepeat = true;
        continue;
      }
    }

    prevBranchProductBeforeAtom = currentBranchProduct;
    lastAtomProduct = 1;
    canRepeat = true;
    repeatState = 'none';
  }

  if (frames.length > 1) {
    return 'invalid_syntax';
  }
  return null;
}
