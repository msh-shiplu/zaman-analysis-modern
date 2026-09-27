# Dhaka Stock Exchange (DSE) Scraper & Analytics Dashboard

Automated scrapers and interactive web analytics terminal for Dhaka Stock Exchange (DSE) market data using `bdshare`, Supabase, and GitHub Pages.

## Live Dashboard

- **GitHub Pages Dashboard**: [https://msh-shiplu.github.io/zaman-analysis-modern/](https://msh-shiplu.github.io/zaman-analysis-modern/)
- Every time the dynamic or static scraper runs in GitHub Actions, it stores the scraped records into Supabase (`dse_dynamic` and `dse_static`), exports a consolidated snapshot (`docs/data/market_data.json` including intraday history from Supabase), and automatically deploys the web dashboard to GitHub Pages.
- You can also click **Supabase Live** in the top-right corner of the dashboard to query your Supabase database directly from the browser using your public `anon` key.

## Features

- **Dynamic Scraper (`--type dynamic`)**: Fetches real-time trade data (last traded price, high, low, close, ycp, volume, change) every 30 minutes during market hours (10:00 AM – 2:30 PM BST, Sun–Thu).
- **Static Scraper (`--type static`)**: Fetches daily fundamental P/E metrics across all listed symbols in a single query (4:00 PM BST, Sun–Thu).
- **Web Dashboard Export (`--export-web docs/data`)**: Exports merged dynamic, static P/E, and intraday time-series history to `market_data.json`.
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

- **Generate the web dashboard dataset locally and preview `docs/`:**
  ```bash
  python scraper.py --dry-run --export-web docs/data
  python3 -m http.server 8000 --directory docs
  ```