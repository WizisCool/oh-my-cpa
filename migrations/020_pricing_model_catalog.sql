CREATE TABLE pricing_model_catalog (
 model TEXT PRIMARY KEY,
 price_model TEXT NOT NULL
);
CREATE TABLE pricing_catalog_state (
 id INTEGER PRIMARY KEY CHECK(id=1), updated_at_ms INTEGER NOT NULL
);
INSERT INTO pricing_catalog_state VALUES(1,0);
