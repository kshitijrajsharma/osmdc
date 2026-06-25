"""Aggregate the Kontur Population dataset into a per-H3-cell parquet.

Kontur Population is already an H3 resolution 8 grid, the same grid this pipeline uses,
so each cell joins directly with no resampling. Download the GeoPackage first from
config.KONTUR_POPULATION_URL (a gzipped .gpkg) and decompress it.
"""

from __future__ import annotations

from pathlib import Path

import duckdb


def kontur_to_parquet(
    con: duckdb.DuckDBPyConnection, gpkg_path: str, out_path: Path
) -> tuple[int, float]:
    """Read the Kontur GeoPackage and write an (h3, population) parquet.

    Returns (cell_count, total_population).
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"""
        COPY (
            SELECT h3, round(sum(population)) AS population
            FROM ST_Read('{gpkg_path}')
            GROUP BY h3
        ) TO '{out_path}' (FORMAT PARQUET, COMPRESSION zstd)
    """)
    summary = con.execute(
        f"SELECT count(*), coalesce(sum(population), 0) FROM read_parquet('{out_path}')"
    ).fetchone()
    assert summary is not None
    return summary[0], summary[1]
