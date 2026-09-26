import os
import argparse
import pandas as pd
from datetime import datetime
from supabase import create_client, Client
from bdshare import get_current_trade_data, get_company_info

def init_db() -> Client:
    """Initializes and returns the Supabase client."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    
    if not url or not key:
        raise ValueError("Supabase credentials (SUPABASE_URL, SUPABASE_KEY) not found in environment variables.")
        
    return create_client(url, key)

def fetch_and_store_dynamic(supabase: Client):
    """Fetches real-time trade data and pushes it to Supabase."""
    print(f"Fetching dynamic market data at {datetime.now()}...")
    
    try:
        # Fetch data using bdshare
        df = get_current_trade_data()
        
        if df is None or df.empty:
            print("No data fetched. Market might be closed or website unreachable.")
            return

        # Clean up column names to match standard SQL conventions (lowercase, underscores)
        df.columns = [col.lower().replace(' ', '_') for col in df.columns]
        
        # Append UTC timestamp for time-series tracking
        df['timestamp'] = datetime.utcnow().isoformat()

        # Convert the pandas DataFrame to a list of dictionaries for Supabase
        records = df.to_dict(orient='records')

        # Insert data into the dse_dynamic table
        response = supabase.table("dse_dynamic").insert(records).execute()
        print(f"Successfully inserted {len(records)} records for dynamic market data.")

    except Exception as e:
        print(f"Error fetching dynamic data: {e}")

def fetch_and_store_static(supabase: Client):
    """Fetches daily company fundamental data and upserts it to Supabase."""
    print(f"Fetching static company data at {datetime.now()}...")
    
    # For demonstration, we scrape a subset. 
    # In a full production app, you can query your dynamic table for a distinct list of all symbols.
    symbols = ["GP", "BATBC", "SQUARETEXT", "BEXIMCO", "BRACBANK"]

    for symbol in symbols:
        try:
            df = get_company_info(symbol)
            
            if not df.empty:
                # Convert dataframe to JSON/dict for flexible storage
                data = {
                    "symbol": symbol, 
                    "info": df.to_dict(), 
                    "updated_at": datetime.utcnow().isoformat()
                }
                
                # Upsert updates the record if it exists, or inserts it if it's new
                supabase.table("dse_static").upsert(data).execute()
                print(f"Successfully updated static fundamental data for {symbol}")
                
        except Exception as e:
            print(f"Error fetching static data for {symbol}: {e}")

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