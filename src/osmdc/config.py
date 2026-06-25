"""Static configuration for the Overture to H3 aggregation pipeline."""

OVERTURE_RELEASE = "2026-06-17.0"
OVERTURE_BASE = f"s3://overturemaps-us-west-2/release/{OVERTURE_RELEASE}"
BUILDINGS_PATH = f"{OVERTURE_BASE}/theme=buildings/type=building/*.parquet"
SEGMENTS_PATH = f"{OVERTURE_BASE}/theme=transportation/type=segment/*.parquet"

H3_RESOLUTION = 8
# Coarse parent used to shard output into browser-fetchable tiles.
PARTITION_RESOLUTION = 2

OSM_DATASET = "OpenStreetMap"
S3_REGION = "us-west-2"
