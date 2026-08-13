/**
 * Answers one question about a `down.sql`: does it manage its own transaction,
 * and if so, is that management a single outermost `BEGIN;` … `COMMIT;`?
 *
 * `db-rollback.mjs` sends the bookkeeping `DELETE` and the file to Postgres as
 * one statement batch, which is atomic for exactly two file shapes:
 *
 *   - **bare** — no transaction control at all. The batch runs inside the
 *     implicit transaction block Postgres opens for a multi-statement simple
 *     query, and commits when the batch ends.
 *   - **wrapped** — one `BEGIN;` first and one `COMMIT;` last. The file's
 *     `BEGIN` converts that implicit block into an explicit one rather than
 *     opening a second, so the `DELETE` that preceded it is inside the
 *     transaction the file goes on to commit.
 *
 * Anything else silently splits the rollback across two transactions — a
 * statement after the `COMMIT`, a second `BEGIN`, a `SAVEPOINT` released early.
 * That is the defect TAR-346 fixed, so it is checked rather than assumed.
 *
 * Why a scanner and not a regular expression: three of the `down.sql` files
 * carry dollar-quoted PL/pgSQL bodies whose `BEGIN` is a block opener and not a
 * transaction, and at least one file's header comment discusses `COMMIT;` in
 * prose. Both defeat a text match. Both are invisible to a scanner that skips
 * comments, string literals, quoted identifiers and dollar quotes, and that
 * only considers a keyword to be transaction control when it is the *first*
 * word of a statement — which is also what keeps `CASE … END` from reading as a
 * `COMMIT`.
 */

/** First words that begin a transaction-control statement, and what they do. */
const TRANSACTION_CONTROL = new Map([
  ['BEGIN', 'begin'],
  ['START', 'begin'], // START TRANSACTION
  ['COMMIT', 'commit'],
  ['END', 'commit'],
  ['ROLLBACK', 'rollback'],
  ['ABORT', 'rollback'],
  ['SAVEPOINT', 'savepoint'],
  ['RELEASE', 'savepoint'], // RELEASE [SAVEPOINT]
]);

const WORD_START = /[A-Za-z_]/;
const WORD_BODY = /[A-Za-z0-9_$]/;

/**
 * Splits `sql` into statements, reporting only what this module needs: where
 * each one starts and what its first word is. Everything a first word could
 * hide behind — comments, literals, dollar quotes — is skipped rather than
 * parsed, because none of it can contain a statement boundary.
 */
function scanStatements(sql) {
  const statements = [];
  let statement = null;
  let line = 1;
  let index = 0;

  const startOfStatement = (word) => {
    if (statement === null) {
      statement = { firstWord: word, line };
    }
  };

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === '\n') {
      line += 1;
      index += 1;
      continue;
    }

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    // `-- …` to end of line.
    if (character === '-' && next === '-') {
      const newline = sql.indexOf('\n', index);
      index = newline === -1 ? sql.length : newline;
      continue;
    }

    // `/* … */`, which nests in Postgres.
    if (character === '/' && next === '*') {
      let depth = 1;
      index += 2;

      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else {
          if (sql[index] === '\n') line += 1;
          index += 1;
        }
      }

      continue;
    }

    // `$tag$ … $tag$`. The tag may be empty (`$$`) and is what closes it, so a
    // PL/pgSQL body containing `$$` inside a nested tag still terminates
    // correctly.
    if (character === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));

      if (tag) {
        const close = sql.indexOf(tag[0], index + tag[0].length);
        const end = close === -1 ? sql.length : close + tag[0].length;

        for (let at = index; at < end; at += 1) if (sql[at] === '\n') line += 1;

        startOfStatement(null);
        index = end;
        continue;
      }
    }

    // `'…'` (including `E'…'`, whose backslash escapes only ever hide a quote)
    // and `"…"`. A doubled quote is an escaped one and does not close.
    if (character === "'" || character === '"') {
      const escaped =
        character === "'" &&
        /[eE]/.test(sql[index - 1] ?? '') &&
        !WORD_BODY.test(sql[index - 2] ?? ' ');
      index += 1;

      while (index < sql.length) {
        if (escaped && sql[index] === '\\') {
          index += 2;
          continue;
        }

        if (sql[index] === character) {
          if (sql[index + 1] === character) {
            index += 2;
            continue;
          }

          index += 1;
          break;
        }

        if (sql[index] === '\n') line += 1;
        index += 1;
      }

      startOfStatement(null);
      continue;
    }

    if (character === ';') {
      if (statement !== null) statements.push(statement);
      statement = null;
      index += 1;
      continue;
    }

    if (WORD_START.test(character)) {
      let end = index + 1;
      while (end < sql.length && WORD_BODY.test(sql[end])) end += 1;

      startOfStatement(sql.slice(index, end).toUpperCase());
      index = end;
      continue;
    }

    startOfStatement(null);
    index += 1;
  }

  if (statement !== null) statements.push(statement);

  return statements;
}

/**
 * Classifies a `down.sql` as `bare`, `wrapped`, or unsupported.
 *
 * @param {string} sql
 * @returns {{ shape: 'bare' | 'wrapped', problem: null }
 *          | { shape: 'unsupported', problem: string }}
 */
export function describeTransactionShape(sql) {
  const statements = scanStatements(sql);
  const control = statements
    .map((statement, position) => ({
      ...statement,
      position,
      kind: TRANSACTION_CONTROL.get(statement.firstWord) ?? null,
    }))
    .filter((statement) => statement.kind !== null);

  if (control.length === 0) {
    return { shape: 'bare', problem: null };
  }

  const [first, ...rest] = control;

  if (first.kind !== 'begin' || first.position !== 0) {
    return {
      shape: 'unsupported',
      problem:
        `the first transaction-control statement is "${first.firstWord}" on line ${first.line}, ` +
        'but a down.sql may only open a transaction and only as its first statement',
    };
  }

  if (rest.length !== 1 || rest[0].kind !== 'commit') {
    const offender = rest.find((statement) => statement.kind !== 'commit') ?? rest[1];

    return {
      shape: 'unsupported',
      problem: offender
        ? `"${offender.firstWord}" on line ${offender.line} is a second transaction-control ` +
          'statement; the only one allowed after the opening BEGIN is a single closing COMMIT'
        : 'the opening BEGIN is never committed',
    };
  }

  if (rest[0].position !== statements.length - 1) {
    return {
      shape: 'unsupported',
      problem:
        `${statements.length - 1 - rest[0].position} statement(s) follow the COMMIT on line ` +
        `${rest[0].line}; they would run outside the transaction, so the rollback would only ` +
        'half-apply',
    };
  }

  return { shape: 'wrapped', problem: null };
}
