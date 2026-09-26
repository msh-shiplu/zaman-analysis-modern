import os
import argparse
import pandas as pd
from datetime import datetime
from supabase import create_client, Client
from bdshare import get_current_trade_data, get_latest_pe

def init_db() -> Client:
    """Initializes and returns the Supabase client."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    
    if not url or not key:
        raise ValueError("Supabase credentials (SUPABASE_URL, SUPABASE_KEY) not found in environment variables.")
        
    return create_client(url, key)

def fetch_and_store_dynamic(supabase: Client):
    """Fetches real-time trade data and pushes it to Supabase."""
    print(f"Fetching dynamic market data at {datetime.utcnow()} UTC...")
    
    try:
        # Fetch data using bdshare
        df = get_current_trade_data()
        
        if df is None or df.empty:
            print("No data fetched. Market might be closed or website unreachable.")
            return

        # Clean up column names to match standard SQL conventions (lowercase, underscores)
        df.columns = [str(col).lower().replace(' ', '_') for col in df.columns]
        
        # Append UTC timestamp for time-series tracking
        df['timestamp'] = datetime.utcnow().isoformat()

        # Convert the pandas DataFrame to a list of dictionaries for Supabase
        records = df.to_dict(orient='records')
        
        # Clean up the data (replace NaN/Not-a-Number with None for JSON/SQL compatibility)
        cleaned_records = []
        for row in records:
            clean_row = {}
            for k, v in row.items():
                if pd.isna(v):
                    clean_row[k] = None
                else:
                    clean_row[k] = v
            cleaned_records.append(clean_row)

        # Insert data into the dse_dynamic table
        if cleaned_records:
            response = supabase.table("dse_dynamic").insert(cleaned_records).execute()
            print(f"Successfully inserted {len(cleaned_records)} records for dynamic market data.")

    except Exception as e:
        print(f"Error fetching dynamic data: {e}")

def fetch_and_store_static(supabase: Client):
    """Fetches end-of-day static data for all companies in a single request."""
    print(f"Fetching static company data at {datetime.utcnow()} UTC...")
    
    try:
        # Fetches a single DataFrame containing daily static metrics for all symbols
        df = get_latest_pe()
        
        if df is not None and not df.empty:
            # Clean up column names to match standard SQL conventions
            df.columns = [str(col).lower().replace(' ', '_') for col in df.columns]
            
            # Add timestamp
            df['timestamp'] = datetime.utcnow().isoformat()
            
            # Convert DataFrame to a list of dictionaries for database insertion
            records = df.to_dict(orient='records')
            
            # Clean up the data (replace NaN/Not-a-Number with None for SQL compatibility)
            cleaned_records = []
            for row in records:
                clean_row = {}
                for k, v in row.items():
                    if pd.isna(v):
                        clean_row[k] = None
                    else:
                        clean_row[k] = v
                cleaned_records.append(clean_row)

            # Insert into database
            if cleaned_records:
                # Inserts into the 'dse_static' table in Supabase
                response = supabase.table('dse_static').insert(cleaned_records).execute()
                print(f"Successfully inserted {len(cleaned_records)} static records.")
                
    except Exception as e:
        print(f"Error fetching static data: {e}")

if __name__ == "__main__":
    # Setup argument parser to distinguish between cron job schedules
    parser = argparse.ArgumentParser(description="Dhaka Stock Exchange Scraper")
    parser.add_argument(
        '--type', 
        choices=['dynamic', 'static'], 
        required=True, 
        help="Specify 'dynamic' for half-hourly data or 'static' for daily fundamental data"
    )
    args = parser.parse_args()

    # Initialize DB connection
    db_client = init_db()

    # Route execution based on passed argument
    if args.type == 'dynamic':
        fetch_and_store_dynamic(db_client)
    elif args.type == 'static':
        fetch_and_store_static(db_client)
