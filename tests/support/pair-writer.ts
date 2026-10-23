import { Database } from "bun:sqlite";

/** Writes pairs of rows, each pair in one transaction, so a reader sees both rows of a pair or neither. */
const [path, rounds] = process.argv.slice(2);
if (!path || !rounds) throw new Error("usage: pair-writer <database> <rounds>");

const db = new Database(path, { create: true });
db.exec(
  "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS pairs (n INTEGER NOT NULL, side TEXT NOT NULL)",
);
const insert = db.prepare("INSERT INTO pairs (n, side) VALUES (?, ?)");
const writePair = db.transaction((n: number) => {
  insert.run(n, "a");
  insert.run(n, "b");
});
for (let n = 0; n < Number(rounds); n++) writePair(n);
db.close();
