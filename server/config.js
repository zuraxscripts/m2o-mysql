"use strict";

function fromEnv() {
  try {
    if (
      typeof process !== "undefined" &&
      process &&
      process.env
    ) {
      return (
        process.env.MYSQL_CONNECTION_STRING ||
        process.env.mysql_connection_string ||
        ""
      );
    }
  } catch (_) {}

  return "";
}

module.exports = Object.freeze({
  connectionString: fromEnv(),
  host: "localhost",
  port: 3306,
  database: "m2o",
  user: "root",
  password: "",
  connectionLimit: 10,
  slowQueryWarningMs: 150,
  debug: false
});
