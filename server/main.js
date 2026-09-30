"use strict";

var RES = "m2o-mysql";
var CONFIG = null;
try { CONFIG = require("./config"); } catch (_) { CONFIG = {}; }

function safeStr(v, fb) { if (v === null || v === undefined) return fb === undefined ? "" : fb; try { return String(v); } catch (_) { return fb === undefined ? "" : fb; } }
function toNum(v, fb) { var n = Number(v); return (typeof n === "number" && isFinite(n)) ? n : (fb === undefined ? 0 : fb); }
function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function log(m) { try { console.log("[" + RES + "] " + safeStr(m, "")); } catch (_) {} }
function warn(m) { try { console.log("[" + RES + "][WARN] " + safeStr(m, "")); } catch (_) {} }

var pool = null;
var readyFlag = false;
var readyQueue = [];
var lastError = null;
var driverMissing = false;
var connInfo = { host: null, database: null };

function parseConnectionString(str) {
  try {
    str = safeStr(str, "").trim();
    if (!str) return null;

    if (str.indexOf("://") !== -1) {
      var u = new URL(str);
      return {
        host: u.hostname || "localhost",
        port: toNum(u.port || 3306, 3306),
        database: safeStr(u.pathname || "", "").replace(/^\//, ""),
        user: safeStr(u.username || "root", "root"),
        password: safeStr(u.password || "", "")
      };
    }

    var out = {};

    str.split(";").forEach(function (part) {
      var i = part.indexOf("=");
      if (i === -1) return;

      out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    });

    if (!out.host && !out.database) return null;

    return {
      host: out.host || "localhost",
      port: toNum(out.port || 3306, 3306),
      database: out.database || out.db || "",
      user: out.user || out.uid || "root",
      password: out.password || out.pwd || ""
    };
  } catch (_) {
    return null;
  }
}

function resolveOptions() {
  try {
    var fromStr = parseConnectionString(CONFIG.connectionString);
    if (fromStr) return fromStr;

    if (CONFIG.host && CONFIG.database) {
      return {
        host: safeStr(CONFIG.host, "localhost"),
        port: toNum(CONFIG.port || 3306, 3306),
        database: safeStr(CONFIG.database, ""),
        user: safeStr(CONFIG.user, "root"),
        password: safeStr(CONFIG.password, "")
      };
    }
  } catch (_) {}

  return null;
}

function normalizeParams(sql, params) {
  try {
    sql = safeStr(sql, "");

    if (params === undefined || params === null) {
      return { sql: sql, values: [] };
    }

    if (Array.isArray(params)) {
      return { sql: sql, values: params.slice() };
    }

    if (isObj(params)) {
      var values = [];

      var out = sql.replace(
        /([:@])([A-Za-z_][A-Za-z0-9_]*)/g,
        function (match, sig, name) {
          if (Object.prototype.hasOwnProperty.call(params, name)) {
            values.push(params[name]);
            return "?";
          }

          return match;
        }
      );

      return {
        sql: out,
        values: values
      };
    }

    return {
      sql: sql,
      values: [params]
    };
  } catch (_) {
    return {
      sql: safeStr(sql, ""),
      values: []
    };
  }
}

function slowMs() {
  try {
    return Math.max(
      0,
      Math.floor(toNum(CONFIG.slowQueryWarningMs, 150))
    );
  } catch (_) {
    return 150;
  }
}

function debugOn() {
  try {
    return !!CONFIG.debug;
  } catch (_) {
    return false;
  }
}

function shortSql(sql) {
  try {
    var s = safeStr(sql, "")
      .replace(/\s+/g, " ")
      .trim();

    return s.length > 160
      ? s.slice(0, 160) + "..."
      : s;
  } catch (_) {
    return "";
  }
}

function errMsg(e, fb) {
  try {
    fb = fb || "unknown-error";

    if (!e) return fb;

    if (e.message) {
      return e.code
        ? (safeStr(e.code, "") + ": " + e.message)
        : e.message;
    }

    if (Array.isArray(e.errors) && e.errors.length) {
      var parts = [];

      for (var i = 0; i < e.errors.length; i++) {
        var x = e.errors[i];
        if (!x) continue;

        if (x.message) {
          parts.push(
            x.code
              ? (x.code + ": " + x.message)
              : x.message
          );
        } else if (x.code) {
          parts.push(String(x.code));
        }
      }

      if (parts.length) {
        return parts.join("; ");
      }
    }

    if (e.code) {
      return String(e.code) +
        (e.errno !== undefined ? " (errno " + e.errno + ")" : "");
    }

    try {
      var s = JSON.stringify(e);
      if (s && s !== "{}") return s.slice(0, 220);
    } catch (_) {}

    return fb;
  } catch (_) {
    return "unknown-error";
  }
}

async function rawQuery(sql, params) {
  var t0 = Date.now();

  try {
    if (!pool) {
      return {
        ok: false,
        error: driverMissing
          ? "mysql-driver-missing"
          : "mysql-not-connected"
      };
    }

    var n = normalizeParams(sql, params);

    if (debugOn()) {
      log("SQL " + shortSql(n.sql));
    }

    var res = await pool.query(n.sql, n.values);
    var ms = Date.now() - t0;
    var lim = slowMs();

    if (lim > 0 && ms >= lim) {
      warn(
        "slow query (" +
        ms +
        "ms): " +
        shortSql(n.sql)
      );
    }

    return {
      ok: true,
      rows: res[0],
      fields: res[1],
      ms: ms
    };
  } catch (e) {
    var msg = errMsg(e, "query-failed");

    lastError = msg;

    warn(
      "query failed: " +
      msg +
      " | " +
      shortSql(sql)
    );

    return {
      ok: false,
      error: msg
    };
  }
}

function isSelect(sql) {
  try {
    return /^\s*(select|show|describe|desc|explain)\b/i
      .test(safeStr(sql, ""));
  } catch (_) {
    return false;
  }
}

async function query(sql, params) {
  try {
    if (!safeStr(sql, "")) return [];

    var r = await rawQuery(sql, params);

    if (!r.ok) return [];

    return (
      r.rows === undefined ||
      r.rows === null
    )
      ? []
      : r.rows;
  } catch (_) {
    return [];
  }
}

async function single(sql, params) {
  try {
    var rows = await query(sql, params);

    if (Array.isArray(rows)) {
      return rows.length ? rows[0] : null;
    }

    return isObj(rows) ? rows : null;
  } catch (_) {
    return null;
  }
}

async function scalar(sql, params) {
  try {
    var row = await single(sql, params);

    if (!isObj(row)) return null;

    var keys = Object.keys(row);

    return keys.length
      ? row[keys[0]]
      : null;
  } catch (_) {
    return null;
  }
}

async function insert(sql, params) {
  try {
    var r = await rawQuery(sql, params);

    if (!r.ok) return null;

    if (
      r.rows &&
      typeof r.rows.insertId !== "undefined"
    ) {
      return toNum(r.rows.insertId, null);
    }

    return null;
  } catch (_) {
    return null;
  }
}

async function update(sql, params) {
  try {
    var r = await rawQuery(sql, params);

    if (!r.ok) return 0;

    if (
      r.rows &&
      typeof r.rows.affectedRows !== "undefined"
    ) {
      return toNum(r.rows.affectedRows, 0);
    }

    return 0;
  } catch (_) {
    return 0;
  }
}

async function execute(sql, params) {
  try {
    return await update(sql, params);
  } catch (_) {
    return 0;
  }
}

async function prepare(sql, params) {
  try {
    if (!pool) {
      warn("prepare: not connected");
      return isSelect(sql) ? [] : null;
    }

    var n = normalizeParams(sql, params);

    if (debugOn()) {
      log("PREPARE " + shortSql(n.sql));
    }

    var t0 = Date.now();

    var res = await pool.execute(
      n.sql,
      n.values
    );

    var ms = Date.now() - t0;
    var lim = slowMs();

    if (lim > 0 && ms >= lim) {
      warn(
        "slow prepare (" +
        ms +
        "ms): " +
        shortSql(n.sql)
      );
    }

    return (
      res[0] === undefined ||
      res[0] === null
    )
      ? null
      : res[0];
  } catch (e) {
    lastError = errMsg(e, "prepare-failed");

    warn(
      "prepare failed: " +
      lastError
    );

    return isSelect(sql) ? [] : null;
  }
}

async function transaction(queries, sharedValues) {
  try {
    if (!pool) {
      warn("transaction: not connected");
      return false;
    }

    if (
      !Array.isArray(queries) ||
      queries.length === 0
    ) {
      return false;
    }

    var conn = await pool.getConnection();

    try {
      var level = 2;

      try {
        level = Math.max(
          1,
          Math.min(
            4,
            Math.floor(
              toNum(
                process.env.MYSQL_TX_LEVEL || 2,
                2
              )
            )
          )
        );
      } catch (_) {}

      var levels = {
        1: "REPEATABLE READ",
        2: "READ COMMITTED",
        3: "READ UNCOMMITTED",
        4: "SERIALIZABLE"
      };

      try {
        await conn.query(
          "SET TRANSACTION ISOLATION LEVEL " +
          levels[level]
        );
      } catch (_) {}

      await conn.beginTransaction();

      for (var i = 0; i < queries.length; i++) {
        var q = queries[i];

        var sql = Array.isArray(q)
          ? q[0]
          : (q && (q.query || q.sql));

        var vals = Array.isArray(q)
          ? q[1]
          : (
              q &&
              (
                q.values ||
                q.params ||
                q.parameters
              )
            );

        if (vals === undefined) {
          vals = sharedValues;
        }

        var n = normalizeParams(sql, vals);

        if (debugOn()) {
          log("TX " + shortSql(n.sql));
        }

        await conn.query(
          n.sql,
          n.values
        );
      }

      await conn.commit();

      return true;
    } catch (e) {
      try {
        await conn.rollback();
      } catch (_) {}

      lastError = errMsg(
        e,
        "transaction-failed"
      );

      warn(
        "transaction rolled back: " +
        lastError
      );

      return false;
    } finally {
      try {
        conn.release();
      } catch (_) {}
    }
  } catch (_) {
    return false;
  }
}

function ready(cb) {
  try {
    if (typeof cb === "function") {
      if (readyFlag) {
        try {
          setImmediate(cb);
        } catch (_) {
          try {
            cb();
          } catch (_) {}
        }
      } else {
        readyQueue.push(cb);
      }
    }

    return Promise.resolve(readyFlag);
  } catch (_) {
    return Promise.resolve(false);
  }
}

function isReady() {
  try {
    return !!readyFlag;
  } catch (_) {
    return false;
  }
}

async function ping() {
  try {
    if (!pool) return false;

    await pool.query(
      "SELECT 1 AS ok"
    );

    return true;
  } catch (_) {
    return false;
  }
}

function getLastError() {
  try {
    return lastError;
  } catch (_) {
    return null;
  }
}

function getConnectionInfo() {
  try {
    return {
      connected: !!pool && readyFlag,
      host: connInfo.host,
      database: connInfo.database
    };
  } catch (_) {
    return {
      connected: false,
      host: null,
      database: null
    };
  }
}

async function connect() {
  try {
    var opts = resolveOptions();

    if (!opts || !opts.database) {
      log(
        "no connection string - staying disconnected " +
        "(queries return safe defaults)."
      );

      log(
        "Set MYSQL_CONNECTION_STRING env or server/config.js to enable."
      );

      return false;
    }

    var mysql = null;

    try {
      mysql = require("mysql2/promise");
    } catch (e) {
      driverMissing = true;

      warn(
        "mysql2 package missing - run `npm install` in m2o-mysql. " +
        "Staying disconnected."
      );

      return false;
    }

    pool = mysql.createPool({
      host: opts.host,
      port: opts.port,
      database: opts.database,
      user: opts.user,
      password: opts.password,
      waitForConnections: true,
      connectionLimit: Math.max(
        1,
        Math.min(
          50,
          Math.floor(
            toNum(
              CONFIG.connectionLimit || 10,
              10
            )
          )
        )
      ),
      queueLimit: 0,
      timezone: "Z"
    });

    await pool.query(
      "SELECT 1 AS ok"
    );

    connInfo = {
      host: opts.host,
      database: opts.database
    };

    readyFlag = true;

    log(
      "connected to " +
      opts.host +
      "/" +
      opts.database +
      " (oxmysql-compatible)."
    );

    var q = readyQueue.slice();

    readyQueue = [];

    q.forEach(function (cb) {
      try {
        cb();
      } catch (e) {
        warn(
          "ready cb failed: " +
          (e && e.message)
        );
      }
    });

    return true;
  } catch (e) {
    lastError = errMsg(
      e,
      "connect-failed"
    );

    warn(
      "connect failed (" +
      (opts
        ? (opts.host + "/" + opts.database)
        : "?") +
      "): " +
      lastError +
      " (server runs on, queries return safe defaults)."
    );

    try {
      if (pool) {
        try {
          await pool.end();
        } catch (_) {}
      }
    } catch (_) {}

    pool = null;

    return false;
  }
}

function chat(player, msg) {
  try {
    if (
      typeof Chat !== "undefined" &&
      Chat &&
      Chat.sendToPlayer
    ) {
      Chat.sendToPlayer(
        player,
        safeStr(msg, "")
      );
    }
  } catch (_) {}
}

function handleMysqlCmd(player, argv) {
  try {
    // Player-facing MySQL commands are disabled unless debug is enabled.
    if (!debugOn()) return;

    argv = Array.isArray(argv)
      ? argv.slice()
      : [];

    var sub = safeStr(
      argv[0] || "help",
      "help"
    ).toLowerCase();

    if (
      sub === "help" ||
      sub === "?"
    ) {
      chat(
        player,
        "[mysql] /mysql <status|ping|test|tables>"
      );
      return;
    }

    if (sub === "status") {
      var i = getConnectionInfo();

      chat(
        player,
        "[mysql] " +
        (
          i.connected
            ? "connected " +
              i.host +
              "/" +
              i.database
            : "DISCONNECTED (safe defaults)"
        ) +
        (
          lastError
            ? " | lastErr: " +
              lastError
            : ""
        )
      );

      return;
    }

    if (sub === "ping") {
      ping().then(function (ok) {
        try {
          chat(
            player,
            "[mysql] ping: " +
            (
              ok
                ? "OK"
                : "FAIL" +
                  (
                    lastError
                      ? " (" +
                        lastError +
                        ")"
                      : ""
                  )
            )
          );
        } catch (_) {}
      });

      return;
    }

    if (sub === "tables") {
      query("SHOW TABLES").then(function (rows) {
        try {
          if (!rows || !rows.length) {
            chat(
              player,
              "[mysql] no tables or not connected."
            );
            return;
          }

          var names = rows
            .map(function (r) {
              try {
                return String(
                  r[Object.keys(r)[0]]
                );
              } catch (_) {
                return "?";
              }
            })
            .slice(0, 20);

          chat(
            player,
            "[mysql] tables (" +
            rows.length +
            "): " +
            names.join(", ")
          );
        } catch (_) {}
      });

      return;
    }

    if (sub === "test") {
      (async function () {
        try {
          if (!pool) {
            chat(
              player,
              "[mysql] not connected - cannot test."
            );
            return;
          }

          await query(
            "CREATE TABLE IF NOT EXISTS m2o_kv (`key` VARCHAR(191) NOT NULL PRIMARY KEY, `value` LONGTEXT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
          );

          var okTx = await transaction([
            {
              query:
                "INSERT INTO m2o_kv (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
              values: [
                "selftest",
                "ok"
              ]
            }
          ]);

          var v = await scalar(
            "SELECT `value` FROM m2o_kv WHERE `key` = ?",
            ["selftest"]
          );

          await execute(
            "DELETE FROM m2o_kv WHERE `key` = ?",
            ["selftest"]
          );

          chat(
            player,
            "[mysql] selftest: tx=" +
            (okTx ? "OK" : "FAIL") +
            " read=" +
            JSON.stringify(v)
          );
        } catch (_) {
          chat(
            player,
            "[mysql] selftest failed (see server log)."
          );
        }
      })();

      return;
    }

    chat(
      player,
      "[mysql] unknown sub '" +
      sub +
      "'. Try /mysql help."
    );
  } catch (_) {}
}

var mysql = {
  query: query,
  single: single,
  scalar: scalar,
  insert: insert,
  update: update,
  execute: execute,
  prepare: prepare,
  transaction: transaction,
  ready: ready,
  isReady: isReady,
  ping: ping,
  getLastError: getLastError,
  getConnectionInfo: getConnectionInfo,
  fetchAll: query,
  fetchScalar: scalar
};

try {
  if (
    typeof Events !== "undefined" &&
    Events
  ) {
    Events.on(
      "resourceStart",
      function (name) {
        try {
          if (name !== RES) return;

          log(
            "server starting (oxmysql port v1.0.0)..."
          );

          try {
            connect();
          } catch (_) {}
        } catch (_) {}
      }
    );

    Events.on(
      "resourceStop",
      function (name) {
        try {
          if (name !== RES) return;

          readyQueue = [];

          if (pool) {
            var p = pool;

            pool = null;
            readyFlag = false;

            try {
              p.end()
                .then(function () {
                  log("pool closed.");
                })
                .catch(function () {});
            } catch (_) {}
          }

          log("server stopped.");
        } catch (_) {}
      }
    );

    try {
      Events.on(
        "playerCommand",
        function (player, command, args) {
          try {
            if (
              safeStr(command, "")
                .toLowerCase()
                .replace(/^\//, "") !==
              "mysql"
            ) {
              return;
            }

            var argv = Array.isArray(args)
              ? args.slice()
              : String(args || "")
                  .trim()
                  .split(/\s+/)
                  .filter(Boolean);

            handleMysqlCmd(
              player,
              argv
            );
          } catch (_) {}
        }
      );
    } catch (_) {}
  }
} catch (_) {}

mysql.__meta = {
  resource: RES,
  version: "1.0.0",
  runtime: "m2o-server",
  oxCompat: "oxmysql subset"
};

try {
  if (
    typeof Exports !== "undefined" &&
    Exports &&
    typeof Exports.register === "function"
  ) {
    Exports.register(
      "mysql",
      mysql
    );

    [
      "query",
      "execute",
      "single",
      "scalar",
      "insert",
      "update",
      "prepare",
      "transaction",
      "ready",
      "isReady",
      "ping",
      "fetchAll",
      "fetchScalar"
    ].forEach(function (n) {
      try {
        Exports.register(
          n,
          mysql[n]
        );
      } catch (_) {}
    });

    try {
      Exports.register(
        "query_async",
        mysql.query
      );
    } catch (_) {}
  }
} catch (_) {}

try {
  if (
    typeof globalThis !== "undefined"
  ) {
    globalThis.M2OMySQL = mysql;
  }
} catch (_) {}
