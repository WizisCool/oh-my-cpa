CREATE TABLE fonts (
    id TEXT PRIMARY KEY,
    family TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('google','upload')),
    created_at_ms INTEGER NOT NULL
);
CREATE TABLE font_faces (
    id TEXT PRIMARY KEY,
    font_id TEXT NOT NULL REFERENCES fonts(id) ON DELETE CASCADE,
    weight_min INTEGER NOT NULL CHECK(weight_min BETWEEN 1 AND 1000),
    weight_max INTEGER NOT NULL CHECK(weight_max BETWEEN weight_min AND 1000),
    style TEXT NOT NULL CHECK(style IN ('normal','italic')),
    unicode_range TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL CHECK(format IN ('woff2','woff','truetype','opentype')),
    content BLOB NOT NULL,
    position INTEGER NOT NULL
);
CREATE INDEX font_faces_font ON font_faces(font_id, position);
