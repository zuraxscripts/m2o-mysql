# m2o-mysql

oxmysql-compatible MySQL layer for the M2O Node.js runtime, built on `mysql2/promise`.

No function ever throws or rejects. On error it logs and returns a safe default.

## Install

```sh
npm install
```

in this resource directory (`mysql2` dependency).

## Config

Set the connection string via environment (never commit credentials):

```sh
MYSQL_CONNECTION_STRING="mysql://user:pass@host:3306/dbname"
```

URI and `user=root;password=xxx;host=localhost;port=3306;database=m2o` formats
are both accepted. Without a connection string the resource boots disconnected
and every call returns its safe default.

`server/config.js`: `connectionLimit`, `slowQueryWarningMs`, `debug`.

## Usage

```js
const mysql = Exports.get("m2o-mysql", "mysql");

const rows = await mysql.query("SELECT * FROM users WHERE id = ?", [id]);
const row = await mysql.single("SELECT * FROM users WHERE id = ? LIMIT 1", [id]);
const count = await mysql.scalar("SELECT COUNT(*) FROM users", []);
const insertId = await mysql.insert("INSERT INTO notes (owner, text) VALUES (?, ?)", [owner, text]);
const changed = await mysql.update("UPDATE users SET job = ? WHERE id = ?", [job, id]);
const ok = await mysql.transaction([
  { query: "UPDATE users SET bank = bank - ? WHERE id = ?", values: [100, from] },
  { query: "UPDATE users SET bank = bank + ? WHERE id = ?", values: [100, to] },
]);
await mysql.ready();
```

Single-function exports (`query`, `single`, `scalar`, `insert`, `update`,
`execute`, `prepare`, `transaction`, `ready`, `isReady`, `ping`,
`fetchAll`, `fetchScalar`, `query_async`) and one `mysql` object export
are all registered.

Placeholders: `?` with an array, or `:name` / `@name` with an object.

## Safe defaults

| Call | On error |
|---|---|
| `query`, `fetchAll` | `[]` |
| `single`, `scalar`, `insert` | `null` |
| `update`, `execute` | `0` |
| `prepare` | `[]` for SELECT, else `null` |
| `transaction` | `false` |

`mysql.getLastError()` returns the last error message.
`mysql.getConnectionInfo()` returns `{ connected, host, database }`.

## Chat commands

`/mysql status | ping | tables | test`

## License

MIT. oxmysql API design by Overextended.
