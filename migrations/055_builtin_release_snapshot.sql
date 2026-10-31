-- Release discovery stores a current snapshot; immutable observed artifacts and
-- historical releases remain in their existing append-only identity tables.
DROP TABLE builtin_catalog;
CREATE TABLE builtin_catalog (
 id INTEGER PRIMARY KEY CHECK (id=1), document BLOB NOT NULL
);
