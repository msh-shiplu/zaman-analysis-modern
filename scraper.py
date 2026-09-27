import os
import sys
import json
import re
import argparse
import httpx
import pandas as pd
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Set
from supabase import create_client, Client
from bdshare import get_current_trade_data, get_latest_pe

COLUMN_ALIASES: Dict[str, List[str]] = {
    "symbol": ["symbol", "trading_code", "trade_code", "code", "ticker", "instrument"],
    "timestamp": ["timestamp", "updated_at", "created_at", "scraped_at", "fetched_at", "date", "time"],
    "close": ["close", "closep", "close_price", "closing_price"],
    "ltp": ["ltp", "last_traded_price", "price"],
    "high": ["high", "high_price"],
    "low": ["low", "low_price"],
    "ycp": ["ycp", "yesterday_close_price", "yesterdays_close_price"],
    "change": ["change", "chg", "percent_change", "pct_change"],
    "trade": ["trade", "trades", "total_trades"],
    "value": ["value", "value_mn", "turnover"],
    "volume": ["volume", "vol", "total_volume"],
    "pe_1": ["pe_1", "pe1"],
    "pe_2": ["pe_2", "pe2"],
    "pe_3": ["pe_3", "pe3"],
    "pe_4": ["pe_4", "pe4"],
    "pe_5": ["pe_5", "pe5"],
    "pe_6": ["pe_6", "pe6"],
    "pe_trailing": ["pe_trailing", "trailing_pe", "pe"],
}

JSON_CONTAINER_COLS = ["info", "data", "metrics", "pe_data", "details", "payload"]


def load_environment():
    """Attempts to load variables from a local .env file if available."""
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        env_file = os.path.join(os.path.dirname(__file__), ".env")
        if os.path.exists(env_file):
            with open(env_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k = k.strip()
                        v = v.strip().strip("'\"")
                        if k and k not in os.environ:
                            os.environ[k] = v


def init_db() -> Client:
    """Initializes and returns the Supabase client."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")

    if not url or not key:
        raise ValueError("Supabase credentials (SUPABASE_URL, SUPABASE_KEY) not found in environment variables.")

    return create_client(url, key)


def get_table_schema(table_name: str) -> Optional[Set[str]]:
    """
    Queries the Supabase PostgREST OpenAPI spec to discover the exact columns
    defined on `table_name`. Returns a set of column names, or None if unavailable.
    """
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    if not url or not key:
        return None

    try:
        rest_url = f"{url.rstrip('/')}/rest/v1/"
        headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
        }
        resp = httpx.get(rest_url, headers=headers, timeout=15.0)
        if resp.status_code == 200:
            spec = resp.json()
            definitions = spec.get("definitions", {})
            table_def = definitions.get(table_name, {})
            props = table_def.get("properties", {})
            if props:
                cols = set(props.keys())
                print(f"Detected Supabase '{table_name}' schema columns: {sorted(cols)}")
                return cols
    except Exception as e:
        print(f"[Note] Could not inspect OpenAPI schema for '{table_name}': {e}")

    return None


def adapt_records_to_schema(
    records: List[Dict[str, Any]],
    schema_cols: Optional[Set[str]],
    table_name: str,
) -> List[Dict[str, Any]]:
    """
    Adapts cleaned dictionary records to match the target Supabase table's columns:
    - Maps canonical column names (e.g. 'symbol', 'timestamp', 'close') to table aliases
      (e.g. 'trade_code', 'updated_at', 'closep').
    - Packs fundamental fields into a JSONB column (e.g. 'info') if the table uses a
      JSONB structure like (symbol, info, updated_at).
    - Filters out columns not present in the table schema.
    """
    if not records or not schema_cols:
        return records

    # Determine if table uses a JSON container column (e.g., 'info' in dse_static)
    json_col = next((c for c in JSON_CONTAINER_COLS if c in schema_cols), None)

    adapted = []
    for row in records:
        new_row: Dict[str, Any] = {}

        # If a JSON container column exists (such as 'info'), pack non-metadata fields into it
        if json_col:
            info_payload = {
                k: v for k, v in row.items()
                if k not in ("symbol", "timestamp", "updated_at", "created_at")
            }
            new_row[json_col] = info_payload

        # Map canonical fields to matching column names in schema_cols
        for src_col, val in row.items():
            if src_col in schema_cols:
                new_row[src_col] = val
                continue

            aliases = COLUMN_ALIASES.get(src_col, [src_col])
            for alias in aliases:
                if alias in schema_cols:
                    new_row[alias] = val
                    break

        if new_row:
            adapted.append(new_row)

    if adapted:
        print(f"Adapted records for '{table_name}' to columns: {list(adapted[0].keys())}")
    return adapted


def clean_records(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Cleans dictionary records for SQL/JSON insertion:
    - Converts NaN, NaT, Inf, and -Inf to None (SQL NULL).
    - Converts numpy scalars (e.g. np.int64, np.float64) to native Python types.
    """
    cleaned_records = []
    for row in records:
        clean_row = {}
        for k, v in row.items():
            if pd.isna(v) or v is None:
                clean_row[k] = None
            elif isinstance(v, float) and (v == float('inf') or v == float('-inf')):
                clean_row[k] = None
            elif hasattr(v, 'item'):  # Convert numpy scalars to native python types
                clean_row[k] = v.item()
            else:
                clean_row[k] = v
        cleaned_records.append(clean_row)
    return cleaned_records


def clean_dynamic_data(df: pd.DataFrame) -> pd.DataFrame:
    """Cleans and standardizes real-time dynamic market data."""
    df = df.copy()

    # Normalize column names: lowercase, spaces to underscores
    df.columns = [str(col).lower().replace(' ', '_') for col in df.columns]

    # Standardize column naming
    rename_map = {'trade_code': 'symbol', 'code': 'symbol'}
    df = df.rename(columns=rename_map)

    # Convert numeric fields properly, coercing invalid/blank values to NaN
    numeric_cols = ['ltp', 'high', 'low', 'close', 'ycp', 'change', 'trade', 'value', 'volume']
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(
                df[col].astype(str).replace(r'^\s*(n/a|-|--|null|none)?\s*$', '', regex=True),
                errors='coerce'
            )

    # Clean symbol and drop invalid or header rows
    if 'symbol' in df.columns:
        df['symbol'] = df['symbol'].astype(str).str.strip()
        df = df[df['symbol'].str.len() > 0]
        df = df[~df['symbol'].str.lower().isin(['trade code', 'symbol', '#', 'code'])]

    # Append UTC ISO timestamp
    df['timestamp'] = datetime.now(timezone.utc).isoformat()
    return df


def clean_static_data(df: pd.DataFrame) -> pd.DataFrame:
    """
    Cleans and standardizes static P/E fundamental data.
    Fixes the issue where bdshare's get_latest_pe() returns numeric column indices (0, 1, 2, ...).
    """
    df = df.copy()

    # bdshare's get_latest_pe() returns an unlabelled DataFrame with numeric column indices:
    # 0: Trade Code, 1: Close Price, 2: YCP, 3: P/E 1*(Basic), 4: P/E 2*(Diluted),
    # 5: P/E 3*(Basic), 6: P/E 4*(Diluted), 7: P/E 5*, 8: P/E 6*, 9: Trailing P/E (if present)
    if all(str(col).isdigit() for col in df.columns):
        mapping = {
            0: 'symbol',
            1: 'close',
            2: 'ycp',
            3: 'pe_1',
            4: 'pe_2',
            5: 'pe_3',
            6: 'pe_4',
            7: 'pe_5',
            8: 'pe_6',
            9: 'pe_trailing',
        }
        df = df.rename(columns={col: mapping.get(int(col) if str(col).isdigit() else col, f'col_{col}') for col in df.columns})
    else:
        # If columns already have names, normalize them to valid SQL identifiers
        clean_cols = [re.sub(r'[^a-z0-9_]+', '_', str(c).lower().strip()).strip('_') for c in df.columns]
        df.columns = clean_cols
        rename_map = {'trade_code': 'symbol', 'code': 'symbol', 'close_price': 'close'}
        df = df.rename(columns=rename_map)

    # Drop unwanted serial/index columns (like 'sl', 'sn', 'unnamed')
    cols_to_drop = [c for c in df.columns if c in ['sl', 'sn', '_', 'unnamed'] or c.startswith('unnamed')]
    if cols_to_drop:
        df = df.drop(columns=cols_to_drop, errors='ignore')

    # Convert numeric fields properly (treat 'n/a', '-', '', etc. as NaN)
    numeric_cols = ['close', 'ycp', 'pe_1', 'pe_2', 'pe_3', 'pe_4', 'pe_5', 'pe_6', 'pe_trailing']
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(
                df[col].astype(str).replace(r'^\s*(n/a|-|--|null|none)?\s*$', '', regex=True),
                errors='coerce'
            )

    # Clean symbol and drop invalid or header rows
    if 'symbol' in df.columns:
        df['symbol'] = df['symbol'].astype(str).str.strip()
        df = df[df['symbol'].str.len() > 0]
        df = df[~df['symbol'].str.lower().isin(['trade code', 'symbol', '#', 'code'])]

    # Append UTC ISO timestamp
    df['timestamp'] = datetime.now(timezone.utc).isoformat()
    return df


def _write_batch_with_fallback(supabase: Client, table_name: str, batch: List[Dict[str, Any]], prefer_upsert: bool = False):
    """
    Writes a batch of records to `table_name`, handling:
    - Duplicate key conflicts (falls back to upsert).
    - Missing column errors (PGRST204) if OpenAPI schema inspection was unavailable.
    """
    current_batch = [dict(r) for r in batch]
    tried_info_fallback = False

    for _ in range(15):
        if not current_batch or not current_batch[0]:
            raise RuntimeError(f"No matching columns remain to insert into '{table_name}'.")

        try:
            if prefer_upsert:
                supabase.table(table_name).upsert(current_batch).execute()
            else:
                supabase.table(table_name).insert(current_batch).execute()
            return
        except Exception as e:
            err_str = str(e)
            # Handle duplicate primary/unique key conflict by switching to upsert
            if ("23505" in err_str or "duplicate key" in err_str.lower()) and not prefer_upsert:
                prefer_upsert = True
                continue

            # Handle PostgREST missing column error (PGRST204)
            match = re.search(r"Could not find the '([^']+)' column", err_str)
            if match:
                missing_col = match.group(1)
                print(f"[Schema Fallback] Column '{missing_col}' not found in '{table_name}'. Adapting payload...")

                # If flat columns like 'close' are missing in dse_static, try packing into (symbol, info, updated_at)
                if table_name == "dse_static" and missing_col == "close" and not tried_info_fallback:
                    tried_info_fallback = True
                    current_batch = [
                        {
                            "symbol": r.get("symbol"),
                            "info": {k: v for k, v in r.items() if k not in ("symbol", "timestamp", "updated_at")},
                            "updated_at": r.get("timestamp") or r.get("updated_at"),
                        }
                        for r in current_batch
                    ]
                    prefer_upsert = True
                    continue

                # Try known replacement aliases for timestamp/symbol before dropping the column
                if missing_col == "timestamp":
                    for r in current_batch:
                        val = r.pop("timestamp", None)
                        r["updated_at"] = val
                elif missing_col == "updated_at":
                    for r in current_batch:
                        val = r.pop("updated_at", None)
                        r["created_at"] = val
                elif missing_col == "symbol":
                    for r in current_batch:
                        val = r.pop("symbol", None)
                        r["trade_code"] = val
                else:
                    for r in current_batch:
                        r.pop(missing_col, None)
                continue

            raise


def insert_in_batches(
    supabase: Client,
    table_name: str,
    records: List[Dict[str, Any]],
    batch_size: int = 100,
    prefer_upsert: bool = False,
):
    """Inserts/upserts records into Supabase in smaller batches to avoid payload limit / timeout errors."""
    schema_cols = get_table_schema(table_name)
    adapted_records = adapt_records_to_schema(records, schema_cols, table_name)

    total = len(adapted_records)
    for i in range(0, total, batch_size):
        batch = adapted_records[i:i + batch_size]
        _write_batch_with_fallback(supabase, table_name, batch, prefer_upsert=prefer_upsert)


def save_records_to_file(records: List[Dict[str, Any]], prefix: str):
    """Saves records to a local JSON file in an output directory."""
    os.makedirs("output", exist_ok=True)
    filename = f"output/{prefix}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2)
    print(f"Saved {len(records)} records to {filename}")
    return filename


def fetch_and_store_dynamic(supabase: Optional[Client] = None, dry_run: bool = False, save: bool = False) -> List[Dict[str, Any]]:
    """Fetches real-time trade data and pushes it to Supabase (or displays/saves in dry-run mode)."""
    current_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"Fetching dynamic market data at {current_utc} UTC...")

    try:
        df = get_current_trade_data()

        if df is None or df.empty:
            print("No dynamic data fetched. Market might be closed or website unreachable.")
            return []

        df_cleaned = clean_dynamic_data(df)
        records = df_cleaned.to_dict(orient='records')
        cleaned_records = clean_records(records)

        print(f"Fetched and cleaned {len(cleaned_records)} dynamic market records. Columns: {list(df_cleaned.columns)}")

        if save:
            save_records_to_file(cleaned_records, "dynamic")

        if dry_run or supabase is None:
            print("--- Dry Run Sample (first 3 records) ---")
            print(json.dumps(cleaned_records[:3], indent=2))
            return cleaned_records

        # Insert data into the dse_dynamic table
        if cleaned_records:
            insert_in_batches(supabase, "dse_dynamic", cleaned_records, prefer_upsert=False)
            print(f"Successfully stored {len(cleaned_records)} records into 'dse_dynamic' table.")

        return cleaned_records

    except Exception as e:
        print(f"Error processing dynamic data: {e}", file=sys.stderr)
        raise


def fetch_and_store_static(supabase: Optional[Client] = None, dry_run: bool = False, save: bool = False) -> List[Dict[str, Any]]:
    """Fetches end-of-day static data for all companies and pushes to Supabase (or displays/saves in dry-run mode)."""
    current_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"Fetching static company P/E data at {current_utc} UTC...")

    try:
        df = get_latest_pe()

        if df is None or df.empty:
            print("No static data fetched. Website unreachable or table empty.")
            return []

        df_cleaned = clean_static_data(df)
        records = df_cleaned.to_dict(orient='records')
        cleaned_records = clean_records(records)

        print(f"Fetched and cleaned {len(cleaned_records)} static records. Columns: {list(df_cleaned.columns)}")

        if save:
            save_records_to_file(cleaned_records, "static")

        if dry_run or supabase is None:
            print("--- Dry Run Sample (first 3 records) ---")
            print(json.dumps(cleaned_records[:3], indent=2))
            return cleaned_records

        # Upsert/insert into the dse_static table in Supabase
        if cleaned_records:
            insert_in_batches(supabase, "dse_static", cleaned_records, prefer_upsert=True)
            print(f"Successfully stored {len(cleaned_records)} records into 'dse_static' table.")

        return cleaned_records

    except Exception as e:
        print(f"Error processing static data: {e}", file=sys.stderr)
        raise


if __name__ == "__main__":
    # Automatically load .env if present
    load_environment()

    parser = argparse.ArgumentParser(description="Dhaka Stock Exchange Scraper")
    parser.add_argument(
        '--type',
        choices=['dynamic', 'static', 'all'],
        default='all',
        help="Specify 'dynamic' for trade data, 'static' for P/E fundamental data, or 'all' for both (default: 'all')"
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help="Fetch and clean data locally without uploading to Supabase"
    )
    parser.add_argument(
        '--save',
        action='store_true',
        help="Save scraped records to local JSON files in the output/ directory"
    )
    args = parser.parse_args()

    # Determine whether we can / should connect to Supabase
    db_client = None
    dry_run = args.dry_run

    if not dry_run:
        try:
            db_client = init_db()
        except ValueError as err:
            # If running in CI / GitHub Actions, fail fast
            if os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"):
                print(f"Error: {err}", file=sys.stderr)
                sys.exit(1)
            else:
                # When running locally without credentials, switch gracefully to dry-run mode
                print(f"\n[Note] {err}")
                print("[Note] Automatically running in --dry-run mode locally. Set SUPABASE_URL and SUPABASE_KEY in .env or environment to upload to database.\n")
                dry_run = True

    # Execute scrapers based on --type
    try:
        if args.type in ('dynamic', 'all'):
            fetch_and_store_dynamic(supabase=db_client, dry_run=dry_run, save=args.save)
            print()

        if args.type in ('static', 'all'):
            fetch_and_store_static(supabase=db_client, dry_run=dry_run, save=args.save)

    except Exception as exc:
        print(f"Execution failed: {exc}", file=sys.stderr)
        sys.exit(1)
