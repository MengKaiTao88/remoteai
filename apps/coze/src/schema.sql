CREATE TABLE resources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
  draft TEXT NOT NULL, revision INTEGER NOT NULL, published_revision INTEGER,
  mcp_enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE revisions (
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(resource_id, revision)
);
CREATE TABLE documents (
  id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  name TEXT NOT NULL, chunks INTEGER NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL,
  source BLOB NOT NULL, source_hash TEXT NOT NULL, chunk_size INTEGER NOT NULL, overlap INTEGER NOT NULL,
  UNIQUE(knowledge_id, source_hash)
);
CREATE TABLE chunks (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, content TEXT NOT NULL, vector BLOB NOT NULL,
  embedding_model TEXT NOT NULL, UNIQUE(document_id, ordinal)
);
CREATE VIRTUAL TABLE chunk_search USING fts5(content, tokenize='trigram');
CREATE TRIGGER chunk_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_search(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER chunk_delete AFTER DELETE ON chunks BEGIN
  DELETE FROM chunk_search WHERE rowid = old.rowid;
END;
CREATE TRIGGER chunk_update AFTER UPDATE ON chunks BEGIN
  DELETE FROM chunk_search WHERE rowid = old.rowid;
  INSERT INTO chunk_search(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TABLE runs (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, output TEXT,
  trace TEXT NOT NULL DEFAULT '[]', error TEXT, created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  title TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL, citations TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE table_rows (
  id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  value TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX documents_knowledge ON documents(knowledge_id);
CREATE INDEX chunks_document ON chunks(document_id);
CREATE INDEX runs_resource ON runs(resource_id, created_at);
CREATE INDEX messages_conversation ON messages(conversation_id, id);
