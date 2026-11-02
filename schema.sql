CREATE TABLE IF NOT EXISTS items (
  ident  TEXT PRIMARY KEY,
  href_a TEXT NOT NULL,
  etag_a TEXT,
  hash_a TEXT NOT NULL,
  href_b TEXT NOT NULL,
  etag_b TEXT,
  hash_b TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
