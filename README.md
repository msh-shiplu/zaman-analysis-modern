# Dhaka Stock Exchange (DSE) Scraper

Automated scrapers for Dhaka Stock Exchange (DSE) market data using `bdshare` and Supabase.

## Features

- **Dynamic Scraper (`--type dynamic`)**: Fetches real-time trade data (last traded price, high, low, close, ycp, volume, change) every 30 minutes during market hours.
- **Static Scraper (`--type static`)**: Fetches fundamental P/E metrics across all listed symbols in a single query.
- **Local Dry Run (`--dry-run`)**: Scrapes and cleans data without requiring Supabase credentials.
- **Save to File (`--save`)**: Exports fetched data to timestamped JSON files in the `output/` directory.

## Setup

1. **Create and activate a virtual environment:**
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```

2. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

3. **Configure Environment Variables (Optional for local dry-run):**
   Copy `.env.example` to `.env` and fill in your Supabase credentials:
   ```bash
   cp .env.example .env
   ```
   Edit `.env`:
   ```env
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_KEY=your-supabase-key
   ```

## Running Locally

- **Run all scrapers in dry-run mode (local test without database upload):**
  ```bash
  python scraper.py --dry-run
  ```

- **Run dynamic scraper in dry-run mode:**
  ```bash
  python scraper.py --type dynamic --dry-run
  ```

- **Run static fundamental P/E scraper in dry-run mode:**
  ```bash
  python scraper.py --type static --dry-run
  ```

- **Run and save output to JSON files:**
  ```bash
  python scraper.py --save
  ```