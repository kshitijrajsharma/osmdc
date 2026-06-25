from pathlib import Path

import duckdb
import pytest

from osmdc.aggregate import BoundingBox, aggregate_tile, connect, iter_chunks, merge_chunks


def _write_fixture(con: duckdb.DuckDBPyConnection, tmp_path: Path) -> tuple[str, str]:
    """Synthetic Overture-shaped buildings and segments: 3 buildings (2 OSM), 1 road."""
    buildings = tmp_path / "buildings.parquet"
    segments = tmp_path / "segments.parquet"
    con.execute(f"""
        COPY (SELECT * FROM (VALUES
            (struct_pack(xmin := 85.3100::DOUBLE, xmax := 85.3101::DOUBLE,
                         ymin := 27.7100::DOUBLE, ymax := 27.7101::DOUBLE),
             [struct_pack(dataset := 'OpenStreetMap')]),
            (struct_pack(xmin := 85.3102::DOUBLE, xmax := 85.3103::DOUBLE,
                         ymin := 27.7102::DOUBLE, ymax := 27.7103::DOUBLE),
             [struct_pack(dataset := 'OpenStreetMap')]),
            (struct_pack(xmin := 85.3104::DOUBLE, xmax := 85.3105::DOUBLE,
                         ymin := 27.7104::DOUBLE, ymax := 27.7105::DOUBLE),
             [struct_pack(dataset := 'Microsoft')])
        ) AS t(bbox, sources)) TO '{buildings}' (FORMAT PARQUET)
    """)
    con.execute(f"""
        COPY (SELECT
            ST_GeomFromText('LINESTRING(85.3100 27.7100, 85.3105 27.7100)') AS geometry,
            'road' AS subtype,
            struct_pack(xmin := 85.3100::DOUBLE, xmax := 85.3105::DOUBLE,
                        ymin := 27.7100::DOUBLE, ymax := 27.7101::DOUBLE) AS bbox
        ) TO '{segments}' (FORMAT PARQUET)
    """)
    return str(buildings), str(segments)


def test_bbox_rejects_degenerate():
    with pytest.raises(ValueError):
        BoundingBox(85.4, 27.7, 85.3, 27.8)
    with pytest.raises(ValueError):
        BoundingBox(85.3, 27.8, 85.4, 27.7)


def test_aggregate_tile_counts_osm_share(tmp_path):
    con = connect()
    buildings_path, segments_path = _write_fixture(con, tmp_path)
    out_dir = tmp_path / "tiles"

    cells = aggregate_tile(
        con,
        BoundingBox(85.30, 27.70, 85.32, 27.72),
        out_dir,
        buildings_path=buildings_path,
        segments_path=segments_path,
    )

    assert cells >= 1
    assert list(out_dir.glob("h3_parent=*/*.parquet"))

    totals = con.execute(f"""
        SELECT sum(bld_count), sum(bld_osm), sum(road_count), sum(road_len_m)
        FROM read_parquet('{out_dir}/**/*.parquet')
    """).fetchone()
    assert totals is not None
    assert totals[0] == 3
    assert totals[1] == 2
    assert totals[2] == 1
    assert totals[3] > 0


def test_iter_chunks_covers_range_without_overlap():
    chunks = iter_chunks(-180, 180, -60, 84, 360.0, 12.0)
    assert len(chunks) == 12  # full-width latitude bands
    assert chunks[0] == BoundingBox(-180, -60, 180, -48)
    assert chunks[-1].north == 84


def test_merge_sums_border_cells(tmp_path):
    """A cell split across two chunks must be summed, not duplicated."""
    con = connect()
    chunk_dir = tmp_path / "chunks"
    chunk_dir.mkdir()
    for name, bld, osm in [("chunk_0000", 3, 2), ("chunk_0001", 5, 1)]:
        con.execute(f"""
            COPY (SELECT '8abc' AS h3, '82' AS h3_parent,
                         {bld}::BIGINT AS bld_count, {osm}::BIGINT AS bld_osm,
                         0::BIGINT AS road_count, 0.0 AS road_len_m)
            TO '{chunk_dir / name}.parquet' (FORMAT PARQUET)
        """)
    out_dir = tmp_path / "out"
    cells = merge_chunks(con, chunk_dir, out_dir, 8, 2)

    assert cells == 1  # same h3 from both chunks collapses to one row
    row = con.execute(
        f"SELECT bld_count, bld_osm, osm_pct FROM read_parquet('{out_dir}/**/*.parquet')"
    ).fetchone()
    assert row is not None
    assert row[0] == 8
    assert row[1] == 3
    assert row[2] == 37.5
